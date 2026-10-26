"""Bounded, pure projections of caller-admitted listening evidence.

The caller owns authorization, capture admission/anchor reconciliation, mapping
provenance and complete scope/cutoff selection. In particular, a loss receipt's
ENTIRE cumulative count must belong to the selected scope before it is supplied.
These checks cannot establish those external facts. No allocator, persistence,
clock access or automatic/manual progress mutation lives here.
"""
from copy import deepcopy
from fractions import Fraction
from math import gcd
import re


_MAX_I64 = (1 << 63) - 1
_UNKNOWN = 'unknown'
_CODES = (
    'invalid_shape', 'invalid_integer', 'invalid_rational', 'invalid_identifier',
    'invalid_namespace', 'invalid_time_bounds', 'invalid_snapshot', 'invalid_policy',
    'invalid_target', 'scope_mismatch', 'mapping_missing', 'mapping_conflict',
    'evidence_conflict', 'checkpoint_digest_conflict',
)
_HISTORY_REASONS = ('history_partial', 'history_unknown', 'mapping_unresolved', 'source_unavailable')
_EVENT_KINDS = ('natural_transition', 'seek', 'loop', 'pause', 'resume', 'stop',
                'context_suspend', 'context_close', 'owner_reset', 'underflow',
                'measurement_change', 'capture_resync')
_UNKNOWN_OBSERVATIONS = ('context_suspend', 'context_close', 'owner_reset', 'pause', 'resume')
_MAPPING_FIELDS = ('actor_id library_id mapping_id revision authority_ref '
                   'local_album_key catalog_album_ref')


def _is_integer(value, minimum=-(1 << 63)):
    return type(value) is int and minimum <= value <= _MAX_I64


def _is_id(value):
    if type(value) is not str or not 1 <= len(value) <= 128:
        return False
    if any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        return False
    try:
        return len(value.encode('utf-8')) <= 128
    except UnicodeEncodeError:
        return False


class _Validation:
    """Collect domain errors so error precedence never depends on input order."""

    def __init__(self):
        self.errors = set()

    def require(self, condition, code='invalid_shape'):
        if not condition:
            self.errors.add(code)
        return condition

    def record(self, value, fields, code='invalid_shape'):
        return self.require(type(value) is dict and value.keys() == set(fields.split()), code)

    def integer(self, value, minimum=0):
        return self.require(_is_integer(value, minimum), 'invalid_integer')

    def identifier(self, value, kind='id'):
        valid = _is_id(value)
        if valid and kind == 'uuid':
            valid = re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value) is not None
        elif valid and kind == 'digest':
            valid = re.fullmatch(r'[0-9a-f]{64}', value) is not None
        return self.require(valid, 'invalid_identifier')

    def enum(self, value, choices):
        return self.require(type(value) is str and value in choices, 'invalid_namespace')

    def boolean(self, value):
        return self.require(type(value) is bool)

    def rational(self, value, nonnegative=False):
        if not self.record(value, 'numerator denominator', 'invalid_rational'):
            return False
        n, d = value['numerator'], value['denominator']
        valid = _is_integer(n) and _is_integer(d, 1)
        if valid:
            valid = gcd(abs(n), d) == 1 and (not nonnegative or n >= 0)
        return self.require(valid, 'invalid_rational')

    def time(self, value, occurrence=False):
        if occurrence and value is None:
            return
        fields = 'basis lower upper' if occurrence else 'basis value'
        if not self.record(value, fields):
            return
        self.identifier(value['basis'])
        if occurrence:
            lower = self.rational(value['lower'])
            upper = self.rational(value['upper'])
            if lower and upper:
                self.require(_fraction(value['lower']) <= _fraction(value['upper']), 'invalid_time_bounds')
        else:
            self.rational(value['value'])

    def reasons(self, value):
        if self.require(type(value) is list):
            for reason in value:
                self.enum(reason, _HISTORY_REASONS)

    def scope_fields(self, value, local=False, catalog=False):
        self.integer(value['actor_id'], 1)
        self.integer(value['library_id'], 1)
        if local:
            self.identifier(value['local_album_key'])
        if catalog:
            self.identifier(value['catalog_album_ref'])

    def mapping(self, value):
        if self.record(value, _MAPPING_FIELDS):
            self.scope_fields(value, local=True, catalog=True)
            for field in ('mapping_id', 'revision', 'authority_ref'):
                self.identifier(value[field])

    def first(self):
        return next((code for code in _CODES if code in self.errors), None)


def _fraction(value):
    return Fraction(value['numerator'], value['denominator'])


def _bounded(value):
    if abs(value).bit_length() > 256:
        raise OverflowError
    return value


def _add_fraction(left, right):
    # Reduce shared denominator factors BEFORE cross multiplication, checking
    # each intermediate rather than merely the final reduced answer.
    common = gcd(left.denominator, right.denominator)
    a = _bounded(left.numerator * (right.denominator // common))
    b = _bounded(right.numerator * (left.denominator // common))
    numerator = _bounded(a + b)
    denominator = _bounded((left.denominator // common) * right.denominator)
    return Fraction(numerator, denominator)


def _rational(value):
    return {'numerator': _bounded(value.numerator), 'denominator': _bounded(value.denominator)}


def _metric(value=None, status=None, reason=None):
    return {'value': value, 'status': status or ('unavailable' if value is None else 'exact_recorded'),
            'reasons': [] if reason is None else [reason]}


def _failure(code, completion=False):
    result = {'status': 'incomplete' if code == 'resource_limit' else 'invalid_metrics_input',
              'reasons': [code]}
    if completion:
        result.update(automatic_eligibility=_UNKNOWN, rating_event_ids=[], play_witness_ids=[],
                      item_incarnation_ref=None, participant_baseline_id=None)
    return result


def _too_many(value, limit):
    return type(value) is list and len(value) > limit


def _metrics_limits(batch):
    if type(batch) is not dict:
        return False
    for name, limit in (('runs', 100000), ('continuity', 100000), ('mappings', 4096)):
        if _too_many(batch.get(name), limit):
            return True
    buckets = (batch.get('legacy_measured'), batch.get('imported_reported'))
    if sum(len(v) for v in buckets if type(v) is list) > 1024:
        return True
    snapshot, history = batch.get('snapshot'), batch.get('history')
    if type(snapshot) is dict and _too_many(snapshot.get('members'), 512):
        return True
    if type(history) is dict and _too_many(history.get('reasons'), 8):
        return True
    continuity = batch.get('continuity')
    return type(continuity) is list and any(
        type(e) is dict and _too_many(e.get('lost'), 8) for e in continuity)


def _validate_snapshot(value, v):
    s = _Validation()
    if not s.record(value, 'snapshot_id fingerprint library_id local_album_key catalog_album_ref '
                    'mapping_id status provenance denominator_complete members reason'):
        v.errors.update(s.errors)
        return
    for field in ('snapshot_id', 'local_album_key'):
        s.identifier(value[field])
    s.identifier(value['fingerprint'], 'digest')
    s.integer(value['library_id'], 1)
    for field in ('catalog_album_ref', 'mapping_id'):
        if value[field] is not None:
            s.identifier(value[field])
    s.enum(value['status'], ('observed', 'unknown', 'unavailable', 'overflow'))
    s.enum(value['provenance'], ('local-inventory-v1', 'authoritative-catalog-v1'))
    s.boolean(value['denominator_complete'])
    if value['reason'] is not None:
        s.enum(value['reason'], ('snapshot_unknown', 'snapshot_unavailable', 'snapshot_overflow'))
    if s.require(type(value['members']) is list):
        for member in value['members']:
            if not s.record(member, 'track_id required_class media_extent_frames inventory_duration_ms'):
                continue
            s.integer(member['track_id'], 1)
            s.enum(member['required_class'], ('required', 'optional', 'unknown'))
            if member['media_extent_frames'] is not None:
                s.integer(member['media_extent_frames'], 1)
            if member['inventory_duration_ms'] is not None:
                s.integer(member['inventory_duration_ms'])
    if not s.errors:
        observed = value['status'] == 'observed'
        s.require((value['reason'] is None if observed else
                   value['reason'] == 'snapshot_' + value['status'] and not value['members']
                   and not value['denominator_complete']), 'invalid_snapshot')
        tracks = [m['track_id'] for m in value['members']]
        s.require(len(set(tracks)) == len(tracks), 'invalid_snapshot')
        s.require((value['catalog_album_ref'] is None) == (value['mapping_id'] is None), 'invalid_snapshot')
        if value['denominator_complete']:
            s.require(observed and value['provenance'] == 'authoritative-catalog-v1'
                      and value['catalog_album_ref'] is not None
                      and all(m['required_class'] != 'unknown' and
                              (m['required_class'] != 'required' or m['media_extent_frames'] is not None)
                              for m in value['members']), 'invalid_snapshot')
    v.errors.update(s.errors)


def _validate_run(run, v):
    if not v.record(run, 'actor_id library_id local_album_key track_id capture_parent_uuid checkpoint_sequence '
                    'run_index checkpoint_digest timeline_uuid source_start48 frames output_start ordinal_start '
                    'epoch binding_serial v1_session_uuid anchor_before anchor_after quality occurrence'):
        return
    v.scope_fields(run, local=True)
    for name in ('track_id', 'checkpoint_sequence', 'frames', 'epoch', 'binding_serial'):
        v.integer(run[name], 1)
    for name in ('run_index', 'source_start48', 'output_start', 'ordinal_start'):
        v.integer(run[name])
    if _is_integer(run['frames'], 1):
        for name in ('source_start48', 'output_start', 'ordinal_start'):
            if _is_integer(run[name], 0):
                v.require(run[name] + run['frames'] <= _MAX_I64, 'invalid_integer')
    for name in ('capture_parent_uuid', 'timeline_uuid'):
        v.identifier(run[name], 'uuid')
    v.identifier(run['checkpoint_digest'], 'digest')
    if run['v1_session_uuid'] is not None:
        v.identifier(run['v1_session_uuid'], 'uuid')
    v.enum(run['quality'], ('bounded', 'unknown'))
    for name in ('anchor_before', 'anchor_after'):
        anchor = run[name]
        if anchor is None:
            v.require(run['quality'] != 'bounded')
        elif v.require(type(anchor) is list and len(anchor) == 2):
            v.integer(anchor[0], 1)
            v.integer(anchor[1], 1)
            v.require(anchor[0] == run['epoch'])
    v.time(run['occurrence'], occurrence=True)


def _validate_event(event, v):
    if not v.record(event, 'type actor_id library_id timeline_uuid event_sequence kind output_frame '
                    'before after quality observation occurrence'):
        return
    v.scope_fields(event)
    v.identifier(event['timeline_uuid'], 'uuid')
    v.integer(event['event_sequence'], 1)
    v.enum(event['kind'], _EVENT_KINDS)
    v.enum(event['quality'], ('exact', 'unknown'))
    if event['output_frame'] is not None:
        v.integer(event['output_frame'])
    v.require((event['output_frame'] is not None) == (event['quality'] == 'exact'))
    for name in ('before', 'after'):
        endpoint = event[name]
        if endpoint is not None and v.record(endpoint, 'capture_uuid binding_serial epoch'):
            v.identifier(endpoint['capture_uuid'], 'uuid')
            v.integer(endpoint['binding_serial'], 1)
            v.integer(endpoint['epoch'], 1)
    observation = event['observation']
    if observation is not None and v.record(observation, 'revision generation'):
        v.integer(observation['revision'], 1)
        v.integer(observation['generation'], 1)
    if event['kind'] == 'capture_resync':
        v.require(event['quality'] == 'exact' and event['output_frame'] is not None and observation is not None)
    elif observation is not None:
        v.require(event['kind'] in _UNKNOWN_OBSERVATIONS and event['quality'] == 'unknown'
                  and event['output_frame'] is None)
    v.time(event['occurrence'], occurrence=True)


def _validate_loss(loss, v):
    if not v.record(loss, 'type actor_id library_id local_album_key timeline_uuid evidence_revision summary_id '
                    'through lost reported_positive_frames report_provenance'):
        return
    v.scope_fields(loss, local=True)
    v.identifier(loss['timeline_uuid'], 'uuid')
    for field in ('evidence_revision', 'summary_id'):
        v.identifier(loss[field])
    through_valid = v.integer(loss['through'])
    previous = 0
    if v.require(type(loss['lost']) is list):
        for pair in loss['lost']:
            if not v.require(type(pair) is list and len(pair) == 2):
                continue
            start_valid, end_valid = v.integer(pair[0], 1), v.integer(pair[1], 1)
            if start_valid and end_valid and through_valid:
                v.require(pair[0] <= pair[1] <= loss['through'] and
                          (previous == 0 or pair[0] > previous + 1))
                previous = pair[1]
    count, report = loss['reported_positive_frames'], loss['report_provenance']
    if count is not None:
        v.integer(count)
    v.require((count is None) == (report is None))
    if report is not None and v.record(report, 'basis capture_parent_uuid checkpoint_sequence checkpoint_digest'):
        v.enum(report['basis'], ('accepted_capture_receipt',))
        v.identifier(report['capture_parent_uuid'], 'uuid')
        v.integer(report['checkpoint_sequence'], 1)
        v.identifier(report['checkpoint_digest'], 'digest')


def _validate_bucket(bucket, v, legacy):
    fields = 'actor_id library_id local_album_key source_kind source_record_id revision track_id reported_plays'
    if not v.record(bucket, fields + (' measured_seconds' if legacy else '')):
        return
    v.scope_fields(bucket, local=True)
    v.enum(bucket['source_kind'], ('legacy-measured-v1',) if legacy else
           ('lastfm-scrobble', 'foobar-playcount', 'manual-reported'))
    v.identifier(bucket['source_record_id'])
    v.identifier(bucket['revision'])
    if bucket['track_id'] is not None:
        v.integer(bucket['track_id'], 1)
    if not legacy or bucket['reported_plays'] is not None:
        v.integer(bucket['reported_plays'])
    if legacy and bucket['measured_seconds'] is not None:
        v.rational(bucket['measured_seconds'], nonnegative=True)


def _validate_metrics(batch, policy, target):
    v = _Validation()
    if not v.record(batch, 'actor_id library_id local_album_key source_cutoff evidence_revision scope '
                    'snapshot runs continuity legacy_measured imported_reported mappings history'):
        return v
    v.scope_fields(batch, local=True)
    v.identifier(batch['evidence_revision'])
    v.time(batch['source_cutoff'])
    if v.record(batch['scope'], 'kind baseline_id'):
        scope = batch['scope']
        v.enum(scope['kind'], ('lifetime', 'membership'))
        if scope['baseline_id'] is not None:
            v.identifier(scope['baseline_id'])
        v.require((scope['baseline_id'] is None) == (scope['kind'] == 'lifetime'))
    _validate_snapshot(batch['snapshot'], v)
    if v.record(batch['history'], 'status reasons'):
        history = batch['history']
        v.enum(history['status'], ('complete_recorded_scope', 'partial', 'unknown'))
        v.reasons(history['reasons'])
        v.require(history['status'] != 'complete_recorded_scope' or history['reasons'] == [])
    for field in ('runs', 'continuity', 'legacy_measured', 'imported_reported', 'mappings'):
        if not v.require(type(batch[field]) is list):
            continue
        for entry in batch[field]:
            if field == 'runs':
                _validate_run(entry, v)
            elif field == 'mappings':
                v.mapping(entry)
            elif field in ('legacy_measured', 'imported_reported'):
                _validate_bucket(entry, v, field == 'legacy_measured')
            elif type(entry) is not dict or 'type' not in entry:
                v.require(False)
            elif entry['type'] == 'event':
                _validate_event(entry, v)
            elif entry['type'] == 'loss':
                _validate_loss(entry, v)
            else:
                v.require(False, 'invalid_namespace')
    v.require(_is_integer(target, 1), 'invalid_target')
    if policy is not None:
        valid = (type(policy) is dict and policy.keys() == {'version', 'status'}
                 and _is_id(policy['version']) and type(policy['status']) is str
                 and policy['status'] in ('proposed', 'approved'))
        v.require(valid, 'invalid_policy')
    return v


def _same_scope(value, owner, fields):
    return all(value[field] == owner[field] for field in fields.split())


def _retain(index, key, value, v, code='evidence_conflict'):
    if key in index:
        v.require(index[key] == value, code)
    else:
        index[key] = value


def _deduplicate(entries, fields, v, code='evidence_conflict'):
    index = {}
    for entry in entries:
        _retain(index, tuple(entry[field] for field in fields.split()), entry, v, code)
    return [index[key] for key in sorted(index)]


def _metrics_scope(batch, v):
    snapshot = batch['snapshot']
    v.require(_same_scope(snapshot, batch, 'library_id local_album_key'), 'scope_mismatch')
    tracks = {m['track_id'] for m in snapshot['members']}
    for field in ('runs', 'continuity', 'legacy_measured', 'imported_reported', 'mappings'):
        for entry in batch[field]:
            fields = 'actor_id library_id'
            if 'local_album_key' in entry:
                fields += ' local_album_key'
            v.require(_same_scope(entry, batch, fields), 'scope_mismatch')
            if snapshot['status'] == 'observed' and entry.get('track_id') is not None:
                v.require(entry['track_id'] in tracks, 'scope_mismatch')
            if entry.get('type') == 'loss':
                v.require(entry['evidence_revision'] == batch['evidence_revision'], 'scope_mismatch')
    _deduplicate(batch['mappings'], 'actor_id library_id mapping_id', v, 'mapping_conflict')
    if snapshot['mapping_id'] is not None:
        matching = [m for m in batch['mappings'] if m['mapping_id'] == snapshot['mapping_id']]
        v.require(bool(matching), 'mapping_missing')
        for mapping in matching:
            v.require(mapping['catalog_album_ref'] == snapshot['catalog_album_ref'], 'scope_mismatch')


def _metrics_evidence(batch, v):
    runs = _deduplicate(batch['runs'], 'actor_id library_id capture_parent_uuid checkpoint_sequence run_index', v)
    events = _deduplicate([e for e in batch['continuity'] if e['type'] == 'event'],
                          'actor_id library_id timeline_uuid event_sequence', v)
    losses = _deduplicate([e for e in batch['continuity'] if e['type'] == 'loss'],
                          'actor_id library_id timeline_uuid evidence_revision summary_id', v)
    buckets = _deduplicate(batch['legacy_measured'] + batch['imported_reported'],
                           'actor_id library_id source_kind source_record_id', v)
    # Redundant immutable associations catch contradictions across distinct keys.
    parent_tracks, parent_timelines, bindings, receipts, quantities = {}, {}, {}, {}, {}
    for run in runs:
        parent = run['capture_parent_uuid']
        _retain(parent_tracks, parent, run['track_id'], v)
        _retain(parent_timelines, parent, run['timeline_uuid'], v)
        _retain(bindings, (run['timeline_uuid'], run['binding_serial']), parent, v)
        _retain(receipts, (parent, run['checkpoint_sequence']), run['checkpoint_digest'], v,
                'checkpoint_digest_conflict')
    for event in events:
        for name in ('before', 'after'):
            endpoint = event[name]
            if endpoint is not None:
                parent = endpoint['capture_uuid']
                _retain(parent_timelines, parent, event['timeline_uuid'], v)
                _retain(bindings, (event['timeline_uuid'], endpoint['binding_serial']), parent, v)
    for loss in losses:
        report = loss['report_provenance']
        if report is not None:
            parent = report['capture_parent_uuid']
            key = (parent, report['checkpoint_sequence'])
            _retain(parent_timelines, parent, loss['timeline_uuid'], v)
            _retain(receipts, key, report['checkpoint_digest'], v, 'checkpoint_digest_conflict')
            _retain(quantities, key, loss['reported_positive_frames'], v)
    return runs, losses, buckets


def _raw_position_projection(snapshot, runs):
    intervals = {member['track_id']: [] for member in snapshot['members']}
    native_frames = 0
    for run in runs:
        native_frames = _bounded(native_frames + run['frames'])
        intervals.setdefault(run['track_id'], []).append(
            (run['source_start48'], run['source_start48'] + run['frames']))
    coverage, known_frames = [], 0
    for track, ranges in sorted(intervals.items()):
        union = []
        for start, end in sorted(ranges):
            if union and start <= union[-1][1]:
                union[-1][1] = max(union[-1][1], end)
            else:
                union.append([start, end])
        count = 0
        for start, end in union:
            count = _bounded(count + end - start)
        known_frames = _bounded(known_frames + count)
        coverage.append({'track_id': track, 'source_intervals': union, 'known_position_frames': _metric(count)})
    return native_frames, known_frames, coverage


def _project_metrics(batch, policy, target, runs, losses, buckets):
    native_frames, known_frames, coverage = _raw_position_projection(batch['snapshot'], runs)
    loss_counts = [loss['reported_positive_frames'] for loss in losses
                   if loss['reported_positive_frames'] is not None]
    lost = (_metric(max(loss_counts), 'lower_bound') if loss_counts else
            _metric(reason='loss_time_unknown') if losses else _metric(0))
    sources = {'native-v2': {'source_kind': 'native-v2',
               'seconds': _metric(_rational(Fraction(native_frames, 48000))), 'buckets': []}}
    has_plays = native_frames > 0 or any(count > 0 for count in loss_counts)
    # The sorted bucket order is also the arithmetic order at the 256-bit cap.
    totals, known_times, missing_times = {}, set(), set()
    for bucket in buckets:
        kind = bucket['source_kind']
        group = sources.setdefault(kind, {'source_kind': kind, 'seconds': None, 'buckets': []})
        seconds = bucket.get('measured_seconds')
        count = bucket['reported_plays']
        if seconds is not None:
            fraction = _fraction(seconds)
            totals[kind] = _add_fraction(totals.get(kind, Fraction(0)), fraction)
            known_times.add(kind)
            has_plays = has_plays or fraction > 0
        else:
            missing_times.add(kind)
        has_plays = has_plays or (count is not None and count > 0)
        group['buckets'].append({
            'source_record_id': bucket['source_record_id'], 'revision': bucket['revision'],
            'track_id': bucket['track_id'],
            'reported_plays': _metric(count, reason='source_count_unknown' if count is None else None),
            'seconds': _metric(deepcopy(seconds), reason='source_time_unknown' if seconds is None else None),
        })
    for kind, group in sources.items():
        if kind == 'native-v2':
            continue
        group['seconds'] = (_metric(_rational(totals[kind]),
                                    'lower_bound' if kind in missing_times else 'exact_recorded')
                            if kind in known_times else _metric(reason='source_time_unknown'))
    reasons = set(batch['history']['reasons']) | {'allocation_not_evaluated'}
    if not batch['snapshot']['denominator_complete']:
        reasons.add('denominator_unavailable')
    if policy is not None and policy['status'] == 'proposed':
        reasons.add('qualification_pending')
    metrics = {'known_position_frames': _metric(known_frames), 'reported_lost_frames': lost,
               'native_recorded_frames': _metric(native_frames),
               'source_time_totals': [sources[key] for key in sorted(sources)], 'track_coverage': coverage}
    for field in ('target_coverage', 'tracks_at_target', 'full', 'uninterrupted_full', 'partial',
                  'album_time_equivalents'):
        metrics[field] = _metric(reason='allocation_not_evaluated')
    result = {field: deepcopy(batch[field]) for field in
              ('actor_id', 'library_id', 'local_album_key', 'source_cutoff', 'evidence_revision', 'scope')}
    result.update(status='incomplete', snapshot={field: batch['snapshot'][field] for field in
                  ('snapshot_id', 'fingerprint', 'status')}, history_status=batch['history']['status'],
                  policy_version=None if policy is None else policy['version'],
                  policy_status='absent' if policy is None else policy['status'], target=target,
                  metrics=metrics, witnesses=[], reasons=sorted(reasons),
                  predicates={'has_plays': True if has_plays else
                              False if batch['history']['status'] == 'complete_recorded_scope' else _UNKNOWN,
                              'listened': _UNKNOWN})
    return result


def compute_album_listening_metrics(batch, policy=None, target=5):
    """Project admitted evidence without qualifying Full/Listened or activating policy."""
    if _metrics_limits(batch):
        return _failure('resource_limit')
    v = _validate_metrics(batch, policy, target)
    if v.errors:
        return _failure(v.first())
    _metrics_scope(batch, v)
    if v.errors:
        return _failure(v.first())
    runs, losses, buckets = _metrics_evidence(batch, v)
    if v.errors:
        return _failure(v.first())
    try:
        return _project_metrics(batch, policy, target, runs, losses, buckets)
    except OverflowError:
        return _failure('resource_limit')


def _completion_limits(membership, ratings, plays):
    if _too_many(ratings, 4096) or _too_many(plays, 4096):
        return True
    if type(membership) is dict and _too_many(membership.get('input_reasons'), 8):
        return True
    count = 0
    for entries in (ratings, plays):
        if type(entries) is list:
            for entry in entries:
                if type(entry) is dict and type(entry.get('identity')) is dict:
                    identity = entry['identity']
                    if identity.get('mapping') is not None:
                        count += 1
                        if count > 4096:
                            return True
    return False


def _validate_identity(identity, v):
    if not v.require(type(identity) is dict and 'basis' in identity):
        return
    if identity['basis'] == 'catalog_native':
        if v.record(identity, 'basis authority_ref'):
            v.identifier(identity['authority_ref'])
    elif identity['basis'] == 'local_album':
        if v.record(identity, 'basis local_album_key mapping'):
            v.identifier(identity['local_album_key'])
            if identity['mapping'] is not None:
                v.mapping(identity['mapping'])
    else:
        v.require(False, 'invalid_namespace')


def _validate_completion(membership, ratings, plays):
    v = _Validation()
    if v.record(membership, 'actor_id library_id top_ref catalog_album_ref item_incarnation_ref '
                'participant_baseline_id baseline_time baseline_provenance active revision '
                'input_evidence_complete input_reasons'):
        v.scope_fields(membership, catalog=True)
        for field in ('top_ref', 'item_incarnation_ref', 'participant_baseline_id', 'revision'):
            v.identifier(membership[field])
        v.time(membership['baseline_time'])
        v.boolean(membership['active'])
        v.boolean(membership['input_evidence_complete'])
        v.reasons(membership['input_reasons'])
        v.require(not membership['input_evidence_complete'] or membership['input_reasons'] == [])
        provenance = membership['baseline_provenance']
        if v.record(provenance, 'item_incarnation_ref participant_ref origin authority_ref'):
            for field in ('item_incarnation_ref', 'participant_ref', 'authority_ref'):
                v.identifier(provenance[field])
            v.enum(provenance['origin'], ('item_added', 'materialized', 'participant_associated'))
    for entries, is_rating in ((ratings, True), (plays, False)):
        if not v.require(type(entries) is list):
            continue
        for entry in entries:
            fields = ('actor_id library_id catalog_album_ref occurrence identity ' +
                      ('rating_event_id kind value_ref' if is_rating else
                       'witness_namespace witness_id qualification'))
            if not v.record(entry, fields):
                continue
            v.scope_fields(entry, catalog=True)
            v.time(entry['occurrence'], occurrence=True)
            _validate_identity(entry['identity'], v)
            if is_rating:
                v.identifier(entry['rating_event_id'])
                v.identifier(entry['value_ref'])
                v.enum(entry['kind'], ('native_rating_intent', 'current_preference', 'imported', 'replay', 'recomputed'))
            else:
                v.identifier(entry['witness_namespace'])
                v.identifier(entry['witness_id'])
                qualification = entry['qualification']
                if qualification is not None and v.record(qualification, 'policy_version policy_status result'):
                    if qualification['policy_version'] is not None:
                        v.identifier(qualification['policy_version'])
                    v.enum(qualification['policy_status'], ('approved', 'proposed', 'unknown'))
                    v.require(type(qualification['result']) is bool or
                              (type(qualification['result']) is str and qualification['result'] == _UNKNOWN),
                              'invalid_namespace')
                    v.require(qualification['policy_status'] != 'approved' or
                              qualification['policy_version'] is not None)
    return v


def _completion_scope(membership, ratings, plays, v):
    v.require(membership['baseline_provenance']['item_incarnation_ref'] ==
              membership['item_incarnation_ref'], 'scope_mismatch')
    mappings = []
    for entry in ratings + plays:
        v.require(_same_scope(entry, membership, 'actor_id library_id catalog_album_ref'), 'scope_mismatch')
        identity = entry['identity']
        if identity['basis'] != 'local_album':
            continue
        mapping = identity['mapping']
        v.require(mapping is not None, 'mapping_missing')
        if mapping is not None:
            v.require(_same_scope(mapping, entry, 'actor_id library_id catalog_album_ref')
                      and mapping['local_album_key'] == identity['local_album_key'], 'scope_mismatch')
            mappings.append(mapping)
    _deduplicate(mappings, 'actor_id library_id mapping_id', v, 'mapping_conflict')


def _freshness(occurrence, baseline, reasons):
    if occurrence is None:
        reasons.add('freshness_unknown')
        return _UNKNOWN
    if occurrence['basis'] != baseline['basis']:
        reasons.add('time_basis_mismatch')
        return _UNKNOWN
    threshold = _fraction(baseline['value'])
    if _fraction(occurrence['lower']) > threshold:
        return True
    if _fraction(occurrence['upper']) <= threshold:
        return False
    reasons.add('freshness_unknown')
    return _UNKNOWN


def _and_three(left, right):
    if left is False or right is False:
        return False
    return True if left is True and right is True else _UNKNOWN


def _exists_three(values, complete):
    if any(value is True for value in values):
        return True
    return _UNKNOWN if not complete or _UNKNOWN in values else False


def evaluate_membership_completion_evidence(membership, rating_events, qualifying_play_witnesses):
    """Evaluate supplied approved witnesses; never write or override manual state."""
    if _completion_limits(membership, rating_events, qualifying_play_witnesses):
        return _failure('resource_limit', completion=True)
    v = _validate_completion(membership, rating_events, qualifying_play_witnesses)
    if v.errors:
        return _failure(v.first(), completion=True)
    _completion_scope(membership, rating_events, qualifying_play_witnesses, v)
    if v.errors:
        return _failure(v.first(), completion=True)
    ratings = _deduplicate(rating_events, 'actor_id library_id rating_event_id', v)
    plays = _deduplicate(qualifying_play_witnesses, 'actor_id library_id witness_namespace witness_id', v)
    if v.errors:
        return _failure(v.first(), completion=True)
    complete = membership['input_evidence_complete']
    result = {'status': 'complete' if complete else 'incomplete', 'automatic_eligibility': False,
              'rating_event_ids': [], 'play_witness_ids': [], 'reasons': [],
              'item_incarnation_ref': membership['item_incarnation_ref'],
              'participant_baseline_id': membership['participant_baseline_id']}
    if not membership['active']:
        result['reasons'] = ['inactive_membership'] if complete else ['history_incomplete', 'inactive_membership']
        return result
    reasons = set(membership['input_reasons'])
    if not complete:
        reasons.add('history_incomplete')
    rating_values, play_values = [], []
    for rating in ratings:
        value = (_freshness(rating['occurrence'], membership['baseline_time'], reasons)
                 if rating['kind'] == 'native_rating_intent' else False)
        rating_values.append(value)
        if value is True:
            result['rating_event_ids'].append(rating['rating_event_id'])
    for play in plays:
        freshness = _freshness(play['occurrence'], membership['baseline_time'], reasons)
        qualification = play['qualification']
        q = (qualification['result'] if qualification is not None and
             qualification['policy_status'] == 'approved' else _UNKNOWN)
        if q == _UNKNOWN:
            reasons.add('qualification_pending')
        value = _and_three(freshness, q)
        play_values.append(value)
        if value is True:
            result['play_witness_ids'].append({'witness_namespace': play['witness_namespace'],
                                               'witness_id': play['witness_id']})
    rating_exists = _exists_three(rating_values, complete)
    play_exists = _exists_three(play_values, complete)
    if rating_exists is False:
        reasons.add('rating_missing')
    if play_exists is False:
        reasons.add('play_missing')
    eligibility = _and_three(rating_exists, play_exists)
    result.update(automatic_eligibility=eligibility, reasons=sorted(reasons),
                  status='incomplete' if not complete or eligibility == _UNKNOWN else 'complete')
    return result



# Stage B is an explicitly proposed projection, not qualification authority.
# The unchanged Stage A prefix above remains allocation-inert.
def _candidate_limits(projection):
    if type(projection) is not dict:
        return False
    if _too_many(projection.get('reasons'), 8):
        return True
    if _too_many(projection.get('ordered_track_ids'), 512):
        return True
    entries = projection.get('traversals')
    if type(entries) is not list:
        return False
    if len(entries) > 100000:
        return True
    refs = joins = 0
    for entry in entries:
        if type(entry) is dict:
            if type(entry.get('run_refs')) is list:
                refs += len(entry['run_refs'])
            if type(entry.get('joins')) is list:
                joins += len(entry['joins'])
    return refs > 100000 or joins > 99999


def _candidate_shape(projection, v):
    if not v.record(projection, 'version snapshot_id snapshot_fingerprint authority_ref '
                    'ordered_track_ids partition_status traversals reasons'):
        return
    v.enum(projection['version'], ('album-traversal-projection-v1',))
    for field in ('snapshot_id', 'authority_ref'):
        v.identifier(projection[field])
    v.identifier(projection['snapshot_fingerprint'], 'digest')
    v.enum(projection['partition_status'], ('complete', 'partial', 'unknown'))
    if v.require(type(projection['ordered_track_ids']) is list):
        for track in projection['ordered_track_ids']:
            v.integer(track, 1)
    if v.require(type(projection['reasons']) is list):
        for reason in projection['reasons']:
            v.enum(reason, ('traversal_partial', 'traversal_unknown', 'continuity_unknown',
                            'denominator_unavailable'))
    if not v.require(type(projection['traversals']) is list):
        return
    for traversal in projection['traversals']:
        if not v.record(traversal, 'run_refs joins start_boundary end_boundary'):
            continue
        for field in ('start_boundary', 'end_boundary'):
            v.enum(traversal[field], ('scope_edge', 'break', 'unknown'))
        if v.require(type(traversal['run_refs']) is list):
            v.require(bool(traversal['run_refs']))
            for ref in traversal['run_refs']:
                if v.record(ref, 'capture_parent_uuid checkpoint_sequence run_index'):
                    v.identifier(ref['capture_parent_uuid'], 'uuid')
                    v.integer(ref['checkpoint_sequence'], 1)
                    v.integer(ref['run_index'])
        if v.require(type(traversal['joins']) is list):
            if type(traversal['run_refs']) is list:
                v.require(len(traversal['joins']) == len(traversal['run_refs']) - 1)
            for join in traversal['joins']:
                if not v.record(join, 'kind event_ref gap_basis gap_frames'):
                    continue
                v.enum(join['kind'], ('same_track_contiguous', 'natural_transition'))
                v.enum(join['gap_basis'], ('no_gap', 'confirmed_natural_transition'))
                v.integer(join['gap_frames'])
                ref = join['event_ref']
                if ref is not None and v.record(ref, 'timeline_uuid event_sequence'):
                    v.identifier(ref['timeline_uuid'], 'uuid')
                    v.integer(ref['event_sequence'], 1)


def _candidate_run_key(run):
    return (run['capture_parent_uuid'], run['checkpoint_sequence'], run['run_index'])


def _candidate_event_key(event):
    return (event['timeline_uuid'], event['event_sequence'])


def _candidate_endpoint(run):
    return {'capture_uuid': run['capture_parent_uuid'],
            'binding_serial': run['binding_serial'], 'epoch': run['epoch']}


def _candidate_event_window(index, timeline, start, end, interior=False):
    # Binary-search locators avoid rescanning all continuity records per Run.
    from bisect import bisect_left, bisect_right
    coordinates, events = index.get(timeline, ([], []))
    left = bisect_right(coordinates, start) if interior else bisect_left(coordinates, start)
    right = bisect_left(coordinates, end) if interior else bisect_right(coordinates, end)
    # Callers distinguish zero / one / multiple contradictions, never enumerate
    # this interval. Two representatives preserve that predicate exactly and
    # avoid quadratic copying on invalid overlapping inputs.
    return events[left:min(right, left + 2)]


def _candidate_same_join(left, right):
    return (all(left[name] == right[name] for name in
                ('capture_parent_uuid', 'binding_serial', 'epoch', 'track_id', 'timeline_uuid'))
            and all(left[start] + left['frames'] == right[start] for start in
                    ('source_start48', 'output_start', 'ordinal_start')))


def _candidate_natural_shape(left, right, event):
    end = left['output_start'] + left['frames']
    return (left['timeline_uuid'] == right['timeline_uuid'] == event['timeline_uuid']
            and event['kind'] == 'natural_transition' and event['quality'] == 'exact'
            and event['before'] == _candidate_endpoint(left)
            and event['after'] == _candidate_endpoint(right)
            and end <= right['output_start']
            and end <= event['output_frame'] <= right['output_start'])


def _candidate_natural_geometry(left, right, members, order):
    # None means absence of evidence, not a fabricated transition or rejection.
    a, b = members.get(left['track_id']), members.get(right['track_id'])
    # Missing extent must not mask an independently provable contradiction.
    if right['source_start48'] != 0:
        return False
    if left['track_id'] in order and right['track_id'] in order:
        if order[right['track_id']] != order[left['track_id']] + 1:
            return False
    if a is not None and a['media_extent_frames'] is not None:
        if left['source_start48'] + left['frames'] != a['media_extent_frames']:
            return False
    if a is None or b is None:
        return None
    if a['media_extent_frames'] is None or b['media_extent_frames'] is None:
        return None
    return True


def _candidate_admit(batch, projection, runs, losses, v):
    snapshot = batch['snapshot']
    complete = projection['partition_status'] == 'complete'
    v.require(projection['snapshot_id'] == snapshot['snapshot_id'] and
              projection['snapshot_fingerprint'] == snapshot['fingerprint'], 'scope_mismatch')
    members = {m['track_id']: m for m in snapshot['members']}
    tracks = projection['ordered_track_ids']
    v.require(len(tracks) == len(set(tracks)) and set(tracks) == set(members), 'invalid_snapshot')
    if complete:
        v.require(projection['reasons'] == [], 'evidence_conflict')
    else:
        v.require('traversal_' + projection['partition_status'] in projection['reasons'],
                  'evidence_conflict')
    run_index = {_candidate_run_key(r): r for r in runs}
    events = _deduplicate([e for e in batch['continuity'] if e['type'] == 'event'],
                          'actor_id library_id timeline_uuid event_sequence', v)
    event_index = {_candidate_event_key(e): e for e in events}
    seen, used_events, resolved = set(), set(), []
    for traversal in projection['traversals']:
        if complete:
            v.require(traversal['start_boundary'] != 'unknown' and
                      traversal['end_boundary'] != 'unknown', 'evidence_conflict')
        sequence = []
        for ref in traversal['run_refs']:
            key = _candidate_run_key(ref)
            v.require(key in run_index and key not in seen, 'evidence_conflict')
            seen.add(key)
            if key in run_index:
                sequence.append(run_index[key])
        for join in traversal['joins']:
            ref = join['event_ref']
            if ref is not None:
                key = _candidate_event_key(ref)
                v.require(key in event_index and key not in used_events, 'evidence_conflict')
                used_events.add(key)
        resolved.append(sequence)
    if complete:
        v.require(seen == set(run_index), 'evidence_conflict')
    if v.errors:
        return None
    order = {track: i for i, track in enumerate(tracks)}
    located = {}
    unlocated = any(e['quality'] == 'unknown' for e in events) or any(
        loss['lost'] or (loss['reported_positive_frames'] or 0) > 0 for loss in losses)
    if complete:
        v.require(not unlocated, 'evidence_conflict')
    for event in events:
        if event['quality'] == 'exact':
            located.setdefault(event['timeline_uuid'], []).append(event)
    for timeline, items in located.items():
        items.sort(key=lambda e: (e['output_frame'], e['event_sequence']))
        located[timeline] = ([e['output_frame'] for e in items], items)
    for run in runs:
        member = members.get(run['track_id'])
        if member is not None and member['media_extent_frames'] is not None:
            v.require(run['source_start48'] + run['frames'] <= member['media_extent_frames'],
                      'evidence_conflict')
    uncertain_geometry = False
    ranges = {}
    for traversal, sequence in zip(projection['traversals'], resolved):
        timeline = sequence[0]['timeline_uuid']
        for run in sequence:
            v.require(run['timeline_uuid'] == timeline, 'evidence_conflict')
            v.require(not _candidate_event_window(located, run['timeline_uuid'], run['output_start'],
                      run['output_start'] + run['frames'], interior=True), 'evidence_conflict')
        for left, right, join in zip(sequence, sequence[1:], traversal['joins']):
            window = _candidate_event_window(located, left['timeline_uuid'],
                left['output_start'] + left['frames'], right['output_start'])
            if join['kind'] == 'same_track_contiguous':
                v.require(_candidate_same_join(left, right) and join['event_ref'] is None
                          and join['gap_basis'] == 'no_gap' and join['gap_frames'] == 0
                          and not window, 'evidence_conflict')
            else:
                ref = join['event_ref']
                event = None if ref is None else event_index[_candidate_event_key(ref)]
                gap = right['output_start'] - left['output_start'] - left['frames']
                v.require(event is not None and _candidate_natural_shape(left, right, event)
                          and gap == join['gap_frames'] and 0 <= gap <= 12000
                          and join['gap_basis'] == ('no_gap' if gap == 0 else 'confirmed_natural_transition')
                          and len(window) == 1 and window[0] == event, 'evidence_conflict')
                geometry = _candidate_natural_geometry(left, right, members, order)
                if geometry is None:
                    uncertain_geometry = True
                else:
                    v.require(geometry, 'evidence_conflict')
        ranges.setdefault(timeline, []).append(sequence)
    # Verify that internal frontiers did not split a mechanically eligible join.
    for sequences in ranges.values():
        sequences.sort(key=lambda seq: (seq[0]['output_start'], _candidate_run_key(seq[0])))
        for previous, following in zip(sequences, sequences[1:]):
            left, right = previous[-1], following[0]
            end = left['output_start'] + left['frames']
            v.require(end <= right['output_start'], 'evidence_conflict')
            window = _candidate_event_window(located, left['timeline_uuid'], end, right['output_start'])
            mergeable = _candidate_same_join(left, right) and not window and not unlocated
            gap = right['output_start'] - end
            if (len(window) == 1 and 0 <= gap <= 12000
                    and _candidate_natural_shape(left, right, window[0])):
                geometry = _candidate_natural_geometry(left, right, members, order)
                if geometry is None:
                    uncertain_geometry = True
                elif geometry:
                    if gap > 0:
                        # Separate traversals supply no Join.gap_basis. A short
                        # exact transition is not the missing nonmedia-gap proof.
                        uncertain_geometry = True
                    elif not unlocated:
                        # Zero gap needs no separate nonmedia assertion, but an
                        # unlocated fence still prevents proving mergeability.
                        mergeable = True
            v.require(not mergeable, 'evidence_conflict')
    if uncertain_geometry and complete:
        # A supplied complete claim cannot establish unknown optional transitions.
        v.require(False, 'evidence_conflict')
    return resolved, unlocated or uncertain_geometry


def _candidate_cost_add(left, right):
    """Checked addition in the ordered (token count, exact overlap) group."""
    return (_bounded(left[0] + right[0]),
            _add_fraction(left[1], right[1]))


def _candidate_cost_negate(cost):
    return (_bounded(-cost[0]),
            Fraction(_bounded(-cost[1].numerator), cost[1].denominator))


def _candidate_cost_scale(cost, units):
    return (_bounded(cost[0] * units),
            Fraction(_bounded(cost[1].numerator * units),
                     cost[1].denominator))


def _candidate_actual_overlap(left, right):
    """Intersect sorted, per-track disjoint actual integer source spans."""
    i = j = 0
    overlap = 0
    while i < len(left) and j < len(right):
        left_track, left_start, left_end = left[i]
        right_track, right_start, right_end = right[j]
        if left_track < right_track:
            i += 1
        elif right_track < left_track:
            j += 1
        else:
            start = max(left_start, right_start)
            end = min(left_end, right_end)
            if start < end:
                overlap = _bounded(overlap + _bounded(end - start))
            if left_end <= right_end:
                i += 1
            if right_end <= left_end:
                j += 1
    return Fraction(overlap)


def _candidate_flow_oracle(groups, capacities, outgoing, core_length,
                           demand=None, continuation=None):
    """Cold exact residual min-cost flow, optionally forcing a live prefix.

    Every reservation has already been removed from capacities. A live prefix
    has a capacity-one continuation gate and an ordinary gate of demand - 1.
    Demanding exactly demand units therefore cannot detach the prefix. Its
    final token was already charged, so the gate charges only outgoing overlap.
    Graphs are deliberately rebuilt with nonnegative forward costs; no stale
    residual potentials are reused across different reservations.
    """
    import heapq

    zero = (0, Fraction(0))
    if demand == 0:
        if continuation is not None:
            raise AssertionError('a live prefix requires positive demand')
        return 0, zero
    if continuation is not None and (demand is None or demand < 1):
        raise AssertionError('a live prefix requires finite positive demand')
    group_count = len(groups)
    source = 2 * group_count
    ordinary_gate = source + 1
    continuation_gate = source + 2
    sink = source + 3
    graph = [[] for _ in range(sink + 1)]

    def add_edge(tail, head, capacity, cost):
        if capacity <= 0:
            return
        forward = [head, len(graph[head]), capacity, cost]
        reverse = [tail, len(graph[tail]), 0,
                   _candidate_cost_negate(cost)]
        graph[tail].append(forward)
        graph[head].append(reverse)

    total_capacity = 0
    for capacity in capacities:
        total_capacity = _bounded(total_capacity + capacity)
    flow_limit = total_capacity if demand is None else demand
    ordinary_limit = (flow_limit if continuation is None else demand - 1)
    add_edge(source, ordinary_gate, ordinary_limit, zero)
    if continuation is not None:
        add_edge(source, continuation_gate, 1, zero)
        for index, overlap in outgoing[continuation]:
            if capacities[index]:
                add_edge(continuation_gate, 2 * index, 1, (0, overlap))
    for index, group in enumerate(groups):
        capacity = capacities[index]
        if not capacity:
            continue
        entrance, exit_node = 2 * index, 2 * index + 1
        add_edge(entrance, exit_node, capacity, (1, Fraction(0)))
        if group['a'] == 0:
            add_edge(ordinary_gate, entrance, capacity, zero)
        if group['b'] == core_length:
            add_edge(exit_node, sink, capacity, zero)
        for following, overlap in outgoing[index]:
            if capacities[following]:
                add_edge(exit_node, 2 * following,
                         min(capacity, capacities[following]), (0, overlap))

    potentials = [zero for _ in graph]
    flow = 0
    cost = zero
    while flow < flow_limit:
        distances = [None for _ in graph]
        previous = [None for _ in graph]
        distances[source] = zero
        heap = [(0, Fraction(0), source)]
        while heap:
            tokens, overlap, vertex = heapq.heappop(heap)
            distance = (tokens, overlap)
            if distances[vertex] != distance:
                continue
            for edge_index, edge in enumerate(graph[vertex]):
                following, reverse_index, capacity, edge_cost = edge
                if not capacity:
                    continue
                reduced = _candidate_cost_add(
                    _candidate_cost_add(edge_cost, potentials[vertex]),
                    _candidate_cost_negate(potentials[following]))
                if reduced < zero:
                    # This graph is always cold and starts with nonnegative
                    # forward arcs. A failure is an invariant error, never an
                    # invitation to use Dijkstra with negative reduced costs.
                    raise AssertionError('negative residual reduced cost')
                candidate = _candidate_cost_add(distance, reduced)
                if distances[following] is None or candidate < distances[following]:
                    distances[following] = candidate
                    previous[following] = (vertex, edge_index)
                    heapq.heappush(heap, (candidate[0], candidate[1], following))
        if distances[sink] is None:
            break
        for vertex, distance in enumerate(distances):
            if distance is not None:
                potentials[vertex] = _candidate_cost_add(potentials[vertex], distance)
        units = _bounded(flow_limit - flow)
        vertex = sink
        path_cost = zero
        while vertex != source:
            parent, edge_index = previous[vertex]
            edge = graph[parent][edge_index]
            units = min(units, edge[2])
            path_cost = _candidate_cost_add(path_cost, edge[3])
            vertex = parent
        if units <= 0:
            raise AssertionError('nonpositive residual augmentation')
        vertex = sink
        while vertex != source:
            parent, edge_index = previous[vertex]
            edge = graph[parent][edge_index]
            edge[2] = _bounded(edge[2] - units)
            reverse = graph[vertex][edge[1]]
            reverse[2] = _bounded(reverse[2] + units)
            vertex = parent
        flow = _bounded(flow + units)
        cost = _candidate_cost_add(cost, _candidate_cost_scale(path_cost, units))
    return flow, cost


def _candidate_allocate(groups, core_length):
    """Return max Full, min consumed tokens, and canonical whole-token paths.

    Input groups have identical geometry within each group, with distinct
    canonical token keys. All input data stays unchanged. Only one cold oracle
    graph is resident at a time; no token-pair graph or path enumeration occurs.
    """
    if len(groups) > 512:
        raise OverflowError
    # Geometry order is independent of traversal arrival or stable token IDs.
    groups = sorted(groups, key=lambda group: (
        group['a'], group['b'], group['actual'],
        group['a'] == 0, group['b'] == core_length))
    keys = [sorted(group['keys']) for group in groups]
    capacities = [len(group_keys) for group_keys in keys]
    total_tokens = 0
    for capacity in capacities:
        total_tokens = _bounded(total_tokens + capacity)
    if total_tokens > 4096:
        raise OverflowError
    if total_tokens == 0:
        return 0, 0, []
    outgoing = [[] for _ in groups]
    edge_count = 0
    for index, group in enumerate(groups):
        for following, other in enumerate(groups):
            if other['b'] <= group['b'] or other['a'] > group['b']:
                continue
            overlap = _candidate_actual_overlap(group['actual'], other['actual'])
            if overlap <= 0:
                continue
            edge_count = _bounded(edge_count + 1)
            if edge_count > 130816:
                raise OverflowError
            outgoing[index].append((following, overlap))
    full, optimum = _candidate_flow_oracle(
        groups, capacities, outgoing, core_length)
    remaining_full = full
    remaining_cost = optimum
    offsets = [0 for _ in groups]
    witnesses = []
    while remaining_full:
        path = []
        last = None
        while True:
            if last is None:
                options = [(index, Fraction(0))
                           for index, group in enumerate(groups)
                           if group['a'] == 0 and capacities[index]]
            else:
                options = [(index, overlap) for index, overlap in outgoing[last]
                           if capacities[index]]
            # An equivalent group's smallest unused identity dominates every
            # larger identity for this prefix, without changing feasibility.
            options.sort(key=lambda option: keys[option[0]][offsets[option[0]]])
            selected = None
            for index, overlap in options:
                remainder = _candidate_cost_add(
                    remaining_cost, _candidate_cost_negate((1, overlap)))
                if remainder[0] < 0 or remainder[1] < 0:
                    continue
                capacities[index] -= 1
                finished = groups[index]['b'] == core_length
                needed = remaining_full - 1 if finished else remaining_full
                achieved, residual_cost = _candidate_flow_oracle(
                    groups, capacities, outgoing, core_length,
                    demand=needed, continuation=None if finished else index)
                if achieved == needed and residual_cost == remainder:
                    selected = index
                    remaining_cost = remainder
                    break
                capacities[index] += 1
            if selected is None:
                raise AssertionError('optimal allocation has no feasible prefix')
            path.append(keys[selected][offsets[selected]])
            offsets[selected] += 1
            last = selected
            if groups[selected]['b'] == core_length:
                # End-of-sequence is the first lexicographic choice. Since no
                # valid core endpoint exceeds C, a sink has no continuation.
                witnesses.append(path)
                remaining_full -= 1
                break
    if remaining_cost != (0, Fraction(0)):
        raise AssertionError('canonical refinement did not consume optimum cost')
    witnesses.sort()
    return full, optimum[0], witnesses


def _candidate_union(ranges):
    union = []
    for start, end in sorted(ranges):
        if union and start <= union[-1][1]:
            union[-1][1] = max(union[-1][1], end)
        else:
            union.append([start, end])
    return union


class _CandidateGeometryFold:
    """Shared exact geometry owner; inputs are already admitted monotone spans.

    This arithmetic layer does not admit source provenance, continuity, selected
    membership or completeness. Old Runs and new compact spans have separate
    adapters; neither is cast into the other's evidence type.
    """
    def __init__(self, required, ordered_track_ids, *, span_limit=None, local_total_tolerance=False):
        self.required = required
        self.denominator, self.core_length, self.cores = 0, Fraction(0), {}
        for track in ordered_track_ids:
            if track not in required:
                continue
            extent = required[track]
            self.denominator = _bounded(self.denominator + extent)
            # Preserve historical proposed-candidate defaults. The actual local
            # policy splits ONE total min(1s,0.5%) allowance equally at boundaries.
            trim = (min(Fraction(24000), Fraction(extent, 400)) if local_total_tolerance
                    else min(Fraction(48000), Fraction(extent, 200)))
            self.cores[track] = (trim, extent - trim, self.core_length)
            self.core_length = _add_fraction(self.core_length, extent - 2 * trim)
        self.layers = {track: {} for track in required}
        self.groups, self.tokens, self.uninterrupted = {}, 0, 0
        self.span_limit, self.span_count = span_limit, 0
        self.open_actual, self.open_key, self.sealed = None, None, False

    def begin(self, key):
        if self.sealed or self.open_actual is not None:
            raise ValueError('candidate_geometry_conflict')
        self.open_actual, self.open_key = {}, key

    def add(self, track, start, end):
        if self.sealed or self.open_actual is None:
            raise ValueError('candidate_geometry_conflict')
        self.span_count += 1
        if self.span_limit is not None and self.span_count > self.span_limit:
            raise OverflowError
        if track in self.required:
            self.open_actual.setdefault(track, []).append((start, end))

    def end(self):
        if self.sealed or self.open_actual is None:
            raise ValueError('candidate_geometry_conflict')
        actual, mapped, coverage = [], [], 0
        for track in sorted(self.open_actual):
            trim, core_end, offset = self.cores[track]
            for start, end in _candidate_union(self.open_actual[track]):
                actual.append((track, start, end))
                coverage = _bounded(coverage + end - start)
                points = self.layers[track]
                points[start] = points.get(start, 0) + 1
                points[end] = points.get(end, 0) - 1
                lo, hi = max(start, trim), min(end, core_end)
                if lo < hi:
                    mapped.append((_add_fraction(offset, lo - trim),
                                   _add_fraction(offset, hi - trim)))
        core_union = _candidate_union(mapped)
        if len(core_union) > 1:
            raise ValueError('candidate_geometry_conflict')
        key = self.open_key
        self.open_actual, self.open_key = None, None
        if _bounded(5 * coverage) < self.denominator or not core_union:
            return
        self.tokens += 1
        if self.tokens > 4096:
            raise OverflowError
        a, b = core_union[0]
        self.uninterrupted += a == 0 and b == self.core_length
        identity = (a, b, tuple(actual), a == 0, b == self.core_length)
        if identity not in self.groups:
            if len(self.groups) == 512:
                raise OverflowError
            self.groups[identity] = {'a': a, 'b': b, 'actual': tuple(actual), 'keys': []}
        self.groups[identity]['keys'].append(key)

    def finish(self):
        if self.sealed or self.open_actual is not None:
            raise ValueError('candidate_geometry_conflict')
        self.sealed = True
        ordered = [self.groups[key] for key in sorted(self.groups)]
        for group in ordered:
            group['keys'].sort()
        return (self.denominator, self.core_length, self.layers, ordered,
                self.tokens, self.uninterrupted)


def _candidate_geometry(batch, projection, sequences):
    required = {m['track_id']: m['media_extent_frames'] for m in batch['snapshot']['members']
                if m['required_class'] == 'required'}
    fold = _CandidateGeometryFold(required, projection['ordered_track_ids'])
    for sequence in sequences:
        # Preserve every old canonical Run key and old witness representation.
        fold.begin(tuple(_candidate_run_key(run) for run in sequence))
        for run in sequence:
            fold.add(run['track_id'], run['source_start48'], run['source_start48'] + run['frames'])
        fold.end()
    return fold.finish()


class _HistoryCandidateGeometry:
    """Private compact-span arithmetic, never a successful admission provider.

    Only a real whole-cut source/compatibility owner may supply extents and
    validated monotone spans. This class neither obtains nor fabricates that
    evidence. A missing provider must prevent its use by the future service.
    """
    def __init__(self, member_extents, ordered_track_ids):
        if (type(member_extents) is not dict or not 1 <= len(member_extents) <= 512
                or type(ordered_track_ids) is not tuple
                or len(ordered_track_ids) != len(member_extents)):
            raise ValueError('candidate_geometry_conflict')
        # Bound both collections before inspection; reject bool/float aliases and
        # unhashable IDs before any set equality or dictionary lookup can coerce
        # them into an admitted member. Use the same exact-int law on both sides.
        if (any(not _is_integer(track, 1) or not _is_integer(extent, 1)
                for track, extent in member_extents.items())
                or any(not _is_integer(track, 1) for track in ordered_track_ids)):
            raise ValueError('candidate_geometry_conflict')
        if (len(set(ordered_track_ids)) != len(ordered_track_ids)
                or set(ordered_track_ids) != member_extents.keys()):
            raise ValueError('candidate_geometry_conflict')
        self.fold = _CandidateGeometryFold(dict(member_extents), ordered_track_ids, span_limit=65536)
        self.keys, self.open = {}, False
        self.order = {track: index for index, track in enumerate(ordered_track_ids)}
        self.previous_span = None
        self.finished, self.allocated = False, False
        self.geometry = None

    def begin(self, token_key):
        # Scoped compact keys are formed by the source-owned support fold, not by
        # assigning the first raw checkpoint's identity to a coalesced span.
        valid = type(token_key) is tuple and len(token_key) == 6
        if valid:
            valid = _is_integer(token_key[0], 1)
            check = _Validation()
            check.identifier(token_key[1], 'uuid'); check.identifier(token_key[2], 'uuid')
            check.identifier(token_key[5], 'digest')
            for key in token_key[3:5]:
                if type(key) is not tuple or len(key) != 6:
                    valid = False
                    continue
                valid = valid and all(_is_integer(key[i], 1) for i in (0, 1, 4))
                valid = valid and _is_integer(key[2], 0) and key[2] <= 255
                check.identifier(key[3], 'uuid'); check.identifier(key[5], 'digest')
            valid = valid and not check.errors
        if not valid or self.finished or self.open:
            raise ValueError('candidate_geometry_conflict')
        original_range = token_key[:5]
        if original_range in self.keys:
            raise ValueError('candidate_geometry_conflict')
        if len(self.keys) == 4096:
            raise OverflowError
        self.keys[original_range] = token_key
        self.fold.begin(token_key)
        self.open, self.previous_span = True, None

    def add_span(self, track_id, source_lo, source_hi):
        if (not self.open or not _is_integer(track_id, 1) or track_id not in self.fold.required
                or not _is_integer(source_lo, 0) or not _is_integer(source_hi, 1)
                or not source_lo < source_hi <= self.fold.required[track_id]):
            raise ValueError('candidate_geometry_conflict')
        if self.previous_span is not None:
            previous_track, previous_end = self.previous_span
            contiguous = (track_id == previous_track and source_lo == previous_end)
            next_track = (self.order[track_id] == self.order[previous_track] + 1
                          and previous_end == self.fold.required[previous_track] and source_lo == 0)
            if not (contiguous or next_track):
                raise ValueError('candidate_geometry_conflict')
        self.fold.add(track_id, source_lo, source_hi)
        self.previous_span = (track_id, source_hi)

    def end(self):
        if not self.open or self.previous_span is None:
            raise ValueError('candidate_geometry_conflict')
        self.fold.end()
        self.open = False

    def finish(self):
        if self.finished or self.open:
            raise ValueError('candidate_geometry_conflict')
        self.geometry = self.fold.finish()
        self.finished = True

    def allocate_once(self):
        if not self.finished or self.allocated:
            raise ValueError('candidate_geometry_conflict')
        # Set before entering non-interruptible CPU work: an exception cannot
        # retry this object or grant duplicate token capacity. Its outer job
        # retains the original reservation until the call actually settles.
        self.allocated = True
        denominator, core_length, layers, groups, tokens, uninterrupted = self.geometry
        full, consumed, paths = _candidate_allocate(groups, core_length)
        return dict(full=full, partial=tokens-consumed,
                    uninterrupted_full=uninterrupted, paths=paths)

    def target_projection(self, target):
        if not self.finished or not _is_integer(target, 1):
            raise ValueError('candidate_geometry_conflict')
        denominator, core_length, layers, groups, tokens, uninterrupted = self.geometry
        # A changed saved target reuses valid geometry, never old predicates.
        return _candidate_target(layers, self.fold.required, target, denominator)


def _candidate_target(layers, required, target, denominator):
    covered, tracks_at_target = 0, 0
    for track, extent in sorted(required.items()):
        points = layers[track]
        # Leading/trailing boundaries stay implicit: resident sweep points are
        # only source endpoints (at most two per referenced Run). Missing tails,
        # including a tiny final track, still prevent tracks_at_target.
        count, previous, at_target = 0, 0, True
        for coordinate in sorted(points):
            width = coordinate - previous
            if width:
                covered = _bounded(covered + _bounded(width * min(count, target)))
                if count < target:
                    at_target = False
            count += points[coordinate]
            previous = coordinate
        width = extent - previous
        if width:
            covered = _bounded(covered + _bounded(width * min(count, target)))
            if count < target:
                at_target = False
        tracks_at_target += at_target
    return _rational(Fraction(covered, _bounded(target * denominator))), tracks_at_target


def _candidate_project(batch, projection, target, runs, sequences, continuity_unknown):
    snapshot = batch['snapshot']
    required = {m['track_id']: m['media_extent_frames'] for m in snapshot['members']
                if m['required_class'] == 'required'}
    denominator_known = (snapshot['status'] == 'observed'
        and snapshot['provenance'] == 'authoritative-catalog-v1'
        and snapshot['denominator_complete'] and bool(required)
        and all(m['required_class'] != 'unknown' for m in snapshot['members'])
        and all(extent is not None and extent > 0 for extent in required.values()))
    reasons = {'qualification_pending', 'candidate_only'}
    if batch['history']['status'] != 'complete_recorded_scope':
        reasons.add('history_incomplete')
    # A complete admitted partition can be counted without asserting that older
    # history is complete. Observed-window arithmetic retains its separate scope.
    # This is not recovery from a failed read: admission and partition gates stay
    # unchanged, and the caller still owns a successful authorized selection.
    lower_bound = ('history_incomplete' in reasons
                   and batch['scope']['kind'] != 'observed_window')
    result_reasons = reasons | set(batch['history']['reasons']) | set(projection['reasons'])
    values = {name: None for name in ('full', 'partial', 'uninterrupted_full',
              'target_coverage', 'tracks_at_target', 'album_time_equivalents')}
    dependencies = {name: set() for name in values}
    witnesses = []
    if not denominator_known:
        result_reasons.add('denominator_unavailable')
        for dependency in dependencies.values():
            dependency.add('denominator_unavailable')
    else:
        denominator = 0
        native = 0
        for extent in required.values():
            denominator = _bounded(denominator + extent)
        for run in runs:
            if run['track_id'] in required:
                native = _bounded(native + run['frames'])
        values['album_time_equivalents'] = _rational(Fraction(native, denominator))
        if projection['partition_status'] == 'complete':
            denominator, core_length, layers, groups, tokens, uninterrupted = _candidate_geometry(
                batch, projection, sequences)
            full, consumed, paths = _candidate_allocate(groups, core_length)
            values.update(full=full, partial=tokens - consumed, uninterrupted_full=uninterrupted)
            values['target_coverage'], values['tracks_at_target'] = _candidate_target(
                layers, required, target, denominator)
            for path in paths:
                witnesses.append({'tokens': [
                    [{'capture_parent_uuid': ref[0], 'checkpoint_sequence': ref[1], 'run_index': ref[2]}
                     for ref in token] for token in path], 'uninterrupted': len(path) == 1})
    if projection['partition_status'] != 'complete':
        result_reasons.add('traversal_unknown')
        for name in values:
            if name != 'album_time_equivalents':
                dependencies[name].add('traversal_unknown')
                if continuity_unknown or 'continuity_unknown' in projection['reasons']:
                    dependencies[name].add('continuity_unknown')
        if continuity_unknown:
            result_reasons.add('continuity_unknown')
    metrics = {}
    for name, value in values.items():
        # Missing history can consume leftover tokens, so partial is neither an
        # exact total nor a lower bound. Never publish the subset's leftovers.
        if lower_bound and name == 'partial':
            value = None
        status = 'unavailable' if value is None else 'lower_bound' if lower_bound else 'exact_recorded'
        metrics[name] = {'value': value, 'status': status,
                         'reasons': sorted(reasons | dependencies[name])}
    result = {field: deepcopy(batch[field]) for field in
              ('actor_id', 'library_id', 'local_album_key', 'evidence_revision', 'scope')}
    result.update(status='incomplete', policy_version='album-overlap-r3-candidate-v1',
                  policy_status='proposed', snapshot_id=snapshot['snapshot_id'],
                  snapshot_fingerprint=snapshot['fingerprint'], target=target,
                  qualification='unknown', predicates={'listened': 'unknown'}, completion_witnesses=[],
                  metrics=metrics, required_time_basis='native_required_track_frames',
                  witnesses=witnesses, reasons=sorted(result_reasons))
    return result


def compute_album_listening_candidates(batch, traversal, target=5):
    """Candidate arithmetic over externally admitted maximal traversals only.

    This is proposed-policy analysis, never Listened/Completed qualification.
    The adapter must certify scope, chronology, maximality and complete relevant
    continuity enumeration. These premises cannot be inferred from Runs alone.
    No approximate/greedy fallback or partially optimized output is returned.
    """
    if _metrics_limits(batch) or _candidate_limits(traversal):
        return _failure('resource_limit')
    v = _validate_metrics(batch, None, target)
    _candidate_shape(traversal, v)
    if v.errors:
        return _failure(v.first())
    _metrics_scope(batch, v)
    if v.errors:
        return _failure(v.first())
    runs, losses, buckets = _metrics_evidence(batch, v)
    if v.errors:
        return _failure(v.first())
    admitted = _candidate_admit(batch, traversal, runs, losses, v)
    if v.errors:
        return _failure(v.first())
    sequences, continuity_unknown = admitted
    try:
        # Retain Stage A's exact checked arithmetic contract, but only AFTER all
        # traversal/reference conflicts have been resolved. Discard its projection;
        # neither its reported/imported totals nor its policy metadata enter B.
        _project_metrics(batch, None, target, runs, losses, buckets)
        return _candidate_project(batch, traversal, target, runs, sequences, continuity_unknown)
    except OverflowError:
        return _failure('resource_limit')
    except ValueError as error:
        if error.args == ('candidate_geometry_conflict',):
            return _failure('evidence_conflict')
        raise


# N7 position admission is a distinct, observed-window contract. It neither
# fabricates Stage B events nor upgrades browser reports to decoder attestation.
_POSITION_FIELDS = ('version actor_id library_id observation_id owner window selected_album '
    'snapshot mappings ordered_track_ids runs positions losses observation_status timing_status retirement_status')
_POSITION_RUN_FIELDS = ('actor_id library_id local_album_key track_id capture_parent_uuid '
    'checkpoint_sequence run_index checkpoint_digest timeline_uuid source_start48 frames output_start '
    'ordinal_start epoch binding_serial v1_session_uuid anchor_before anchor_after quality occurrence')
_POSITION_SIDE_FIELDS = ('capture_parent_uuid checkpoint_sequence run_index parent_id checkpoint_id '
    'original_album_id current_album_id generation stream_id source_base48 continuity_serial')
_POSITION_GAP_FIELDS = 'ordinal_start ordinal_end positive_frames output_start output_end epoch reasons'
_POSITION_MAX_BYTES = 1048576
_POSITION_DOMAIN = b'album-haven:album-position-observation:v1\0'


class _PositionInputError(ValueError):
    pass


def _position_limits(value):
    if type(value) is not dict:
        return False
    for key, maximum in (('runs', 256), ('positions', 256), ('losses', 2),
                         ('mappings', 1), ('ordered_track_ids', 512)):
        if _too_many(value.get(key), maximum):
            return True
    snapshot = value.get('snapshot')
    if type(snapshot) is dict and _too_many(snapshot.get('members'), 512):
        return True
    # Outer list caps above precede even these small nested checks.
    for loss in value.get('losses', ()) if type(value.get('losses')) is list else ():
        if type(loss) is dict and _too_many(loss.get('reasons'), 6):
            return True
    return False


def _position_capture_run(run, position):
    keys = ('source_start48 frames output_start ordinal_start epoch binding_serial '
            'anchor_before anchor_after quality').split()
    result = {key: run[key] for key in keys}
    result.update({key: position[key] for key in
                   ('generation', 'stream_id', 'source_base48', 'continuity_serial')})
    return result


def _position_key(value):
    return value['capture_parent_uuid'], value['checkpoint_sequence'], value['run_index']


def _position_content_digest(value):
    # All callers have bounded and validated the complete graph first.
    import hashlib
    import json
    encoder = json.JSONEncoder(sort_keys=True, separators=(',', ':'),
                               ensure_ascii=False, allow_nan=False)
    digest = hashlib.sha256(_POSITION_DOMAIN)
    size = 0
    for chunk in encoder.iterencode(value):
        encoded = chunk.encode('utf-8', errors='strict')
        size += len(encoded)
        if size > _POSITION_MAX_BYTES:
            raise _PositionInputError('resource_limit')
        digest.update(encoded)
    return digest.hexdigest()



def _position_safe(value, minimum=0):
    return _is_integer(value, minimum) and value <= 9007199254740991


def _position_gap_fields(loss, v):
    # N17 consumes the same bounded N9 gap vocabulary, without importing any
    # application package into this standalone pure metrics module.
    valid = True
    for key in ('ordinal_start', 'ordinal_end', 'positive_frames', 'output_start', 'output_end'):
        valid = v.require(_position_safe(loss[key], 1 if key == 'positive_frames' else 0),
                          'invalid_integer') and valid
    if loss['epoch'] is not None:
        v.require(_position_safe(loss['epoch'], 1), 'invalid_integer')
    reasons = loss['reasons']
    if v.require(type(reasons) is list):
        allowed = ('buffer_credit', 'queue_capacity', 'binding_capacity',
                   'timing_discontinuity', 'owner_reset', 'numeric_limit')
        valid_reasons = all(type(reason) is str and reason in allowed for reason in reasons)
        v.require(bool(reasons) and valid_reasons, 'invalid_namespace')
        if valid_reasons:
            v.require(reasons == sorted(set(reasons)))
    if valid:
        v.require(loss['ordinal_end'] - loss['ordinal_start'] >= loss['positive_frames']
                  and loss['output_end'] - loss['output_start'] >= loss['positive_frames'])


def _position_native_fields(run, v):
    for key in ('source_start48', 'frames', 'output_start', 'ordinal_start', 'epoch', 'binding_serial'):
        v.require(_position_safe(run[key], 1 if key in ('frames', 'epoch', 'binding_serial') else 0),
                  'invalid_integer')
    for key in ('source_start48', 'output_start', 'ordinal_start'):
        if _is_integer(run[key], 0) and _is_integer(run['frames'], 1):
            v.require(_position_safe(run[key] + run['frames']), 'invalid_integer')
    for key in ('anchor_before', 'anchor_after'):
        if type(run[key]) is list and len(run[key]) == 2:
            v.require(all(_position_safe(number, 1) for number in run[key]), 'invalid_integer')


def _position_causal_laws(native, v):
    # Necessary N7/N9/N14 laws, not session/extent authority. The real reader
    # independently uses the genuine parser and repository edge validator.
    for index, run in enumerate(native):
        v.require(run['continuity_serial'] <= run['ordinal_start'] + 1, 'evidence_conflict')
        if not index:
            continue
        before = native[index - 1]
        ordinal_gap = run['ordinal_start'] - before['ordinal_start'] - before['frames']
        output_gap = run['output_start'] - before['output_start'] - before['frames']
        v.require(ordinal_gap >= 0 and output_gap >= 0, 'evidence_conflict')
        v.require(run['epoch'] >= before['epoch'] and run['generation'] >= before['generation']
                  and run['continuity_serial'] >= before['continuity_serial'], 'evidence_conflict')
        if run['generation'] != before['generation']:
            v.require(run['epoch'] > before['epoch'], 'evidence_conflict')
        v.require(run['continuity_serial'] - before['continuity_serial'] <= ordinal_gap + 1,
                  'evidence_conflict')
        if run['continuity_serial'] == before['continuity_serial']:
            v.require(run['generation'] == before['generation'] and output_gap == ordinal_gap,
                      'evidence_conflict')



def _prepare_album_position_observation(value, target=5, *, verify_digest=True):
    if _position_limits(value):
        raise _PositionInputError('resource_limit')
    v = _Validation()
    if not v.record(value, _POSITION_FIELDS):
        raise _PositionInputError(v.first())
    v.scope_fields(value)
    v.require(_is_integer(target, 1), 'invalid_target')
    v.enum(value['version'], ('album-position-observation-v1',))
    v.identifier(value['observation_id'], 'digest')
    for key, expected in (('observation_status', 'complete_as_observed'),
                          ('timing_status', 'unknown'), ('retirement_status', 'unknown')):
        v.enum(value[key], (expected,))
    owner, window, album = value['owner'], value['window'], value['selected_album']
    if v.record(owner, 'owner_id device_uuid owner_uuid'):
        v.integer(owner['owner_id'], 1)
        for key in ('device_uuid', 'owner_uuid'):
            v.identifier(owner[key], 'uuid')
        v.require(owner['owner_uuid'] != '00000000-0000-0000-0000-000000000000',
                  'invalid_identifier')
    if v.record(window, 'ordinal_lo ordinal_hi output_lo output_hi'):
        coordinates_valid = True
        for coordinate in window.values():
            coordinates_valid = v.require(_position_safe(coordinate), 'invalid_integer') and coordinates_valid
        if coordinates_valid:
            v.require(window['ordinal_lo'] < window['ordinal_hi']
                      and window['output_lo'] < window['output_hi'])
    if v.record(album, 'local_album_id local_album_key'):
        v.integer(album['local_album_id'], 1)
        v.identifier(album['local_album_key'])
    _validate_snapshot(value['snapshot'], v)
    lists_valid = True
    for key in ('runs', 'positions', 'losses', 'mappings', 'ordered_track_ids'):
        lists_valid = v.require(type(value[key]) is list) and lists_valid
    if not lists_valid:
        raise _PositionInputError(v.first())

    for mapping in value['mappings']:
        v.mapping(mapping)
    for track in value['ordered_track_ids']:
        v.integer(track, 1)
    for run in value['runs']:
        if not v.record(run, _POSITION_RUN_FIELDS):
            continue
        _validate_run(run, v)
        _position_native_fields(run, v)
        v.require(run['occurrence'] is None)
        v.require(_is_integer(run['run_index'], 0) and run['run_index'] <= 255,
                  'invalid_integer')
        v.require(_is_integer(run['checkpoint_sequence'], 1)
                  and run['checkpoint_sequence'] <= 9007199254740991, 'invalid_integer')
    for pos in value['positions']:
        if not v.record(pos, _POSITION_SIDE_FIELDS):
            continue
        v.identifier(pos['capture_parent_uuid'], 'uuid')
        for key in ('parent_id', 'checkpoint_id', 'current_album_id'):
            v.integer(pos[key], 1)
        if pos['original_album_id'] is not None:
            v.integer(pos['original_album_id'], 1)
        for key in ('checkpoint_sequence', 'generation', 'stream_id', 'continuity_serial'):
            v.require(_is_integer(pos[key], 1) and pos[key] <= 9007199254740991, 'invalid_integer')
        v.require(_is_integer(pos['source_base48'], 0)
                  and pos['source_base48'] <= 9007199254740991, 'invalid_integer')
        v.require(_is_integer(pos['run_index'], 0) and pos['run_index'] <= 255, 'invalid_integer')
    for loss in value['losses']:
        if not v.record(loss, 'parent checkpoint_id sequence digest gap_index ' + _POSITION_GAP_FIELDS):
            continue
        if v.record(loss['parent'], 'parent_id capture_uuid original_track_id original_album_id'):
            parent = loss['parent']
            v.identifier(parent['capture_uuid'], 'uuid')
            for key in ('parent_id', 'original_track_id'):
                v.integer(parent[key], 1)
            if parent['original_album_id'] is not None:
                v.integer(parent['original_album_id'], 1)
        v.integer(loss['checkpoint_id'], 1)
        v.require(_is_integer(loss['sequence'], 1) and loss['sequence'] <= 9007199254740991,
                  'invalid_integer')
        v.identifier(loss['digest'], 'digest')
        v.require(_is_integer(loss['gap_index'], 0) and loss['gap_index'] <= 7, 'invalid_integer')
        _position_gap_fields(loss, v)
    if v.errors:
        raise _PositionInputError(v.first())

    runs = {_position_key(r): r for r in _deduplicate(
        value['runs'], 'capture_parent_uuid checkpoint_sequence run_index', v)}
    positions = {_position_key(p): p for p in _deduplicate(
        value['positions'], 'capture_parent_uuid checkpoint_sequence run_index', v)}
    v.require(runs.keys() == positions.keys(), 'evidence_conflict')
    if v.errors:
        raise _PositionInputError(v.first())
    ordered = sorted(runs, key=lambda k: (runs[k]['ordinal_start'], runs[k]['output_start'], *k))
    snapshot = value['snapshot']
    tracks = {m['track_id']: m for m in snapshot['members']}
    v.require(len(set(value['ordered_track_ids'])) == len(value['ordered_track_ids'])
              and set(value['ordered_track_ids']) == tracks.keys(), 'invalid_snapshot')
    v.require(snapshot['library_id'] == value['library_id']
              and snapshot['local_album_key'] == album['local_album_key'], 'scope_mismatch')
    for mapping in value['mappings']:
        v.require(_same_scope(mapping, value, 'actor_id library_id')
                  and mapping['local_album_key'] == album['local_album_key'], 'scope_mismatch')
    if snapshot['mapping_id'] is not None:
        matching = [m for m in value['mappings'] if m['mapping_id'] == snapshot['mapping_id']]
        v.require(bool(matching), 'mapping_missing')
        for mapping in matching:
            v.require(mapping['catalog_album_ref'] == snapshot['catalog_album_ref'], 'scope_mismatch')

    parent_ids, parent_records, v1_links, receipts, checkpoint_ids, bindings = {}, {}, {}, {}, {}, {}
    native = []
    def associate(parent_id, capture_uuid, track, original_album, checkpoint, sequence, digest):
        _retain(parent_ids, parent_id, capture_uuid, v)
        _retain(parent_records, capture_uuid, (parent_id, track, original_album), v)
        _retain(receipts, (parent_id, sequence), (checkpoint, digest), v, 'checkpoint_digest_conflict')
        _retain(checkpoint_ids, checkpoint, (parent_id, sequence, digest), v, 'checkpoint_digest_conflict')

    for key in ordered:
        run, pos = runs[key], positions[key]
        v.require(_same_scope(run, value, 'actor_id library_id')
                  and run['local_album_key'] == album['local_album_key']
                  and pos['current_album_id'] == album['local_album_id']
                  and run['track_id'] in tracks
                  and run['timeline_uuid'] == owner['owner_uuid'], 'scope_mismatch')
        v.require(run['ordinal_start'] < window['ordinal_hi']
                  and run['ordinal_start'] + run['frames'] > window['ordinal_lo'], 'evidence_conflict')
        member = tracks.get(run['track_id'])
        if member is not None and member['media_extent_frames'] is not None:
            v.require(run['source_start48'] + run['frames'] <= member['media_extent_frames'],
                      'evidence_conflict')
        associate(pos['parent_id'], key[0], run['track_id'], pos['original_album_id'],
                  pos['checkpoint_id'], key[1], run['checkpoint_digest'])
        _retain(v1_links, key[0], run['v1_session_uuid'], v)
        _retain(bindings, run['binding_serial'],
                (pos['parent_id'], pos['generation'], pos['stream_id'], pos['source_base48']), v)
        v.require(run['source_start48'] >= pos['source_base48'], 'evidence_conflict')
        native.append(_position_capture_run(run, pos))
    losses = {}
    for loss in value['losses']:
        parent = loss['parent']
        associate(parent['parent_id'], parent['capture_uuid'], parent['original_track_id'],
                  parent['original_album_id'], loss['checkpoint_id'], loss['sequence'], loss['digest'])
        _retain(losses, (parent['parent_id'], loss['checkpoint_id'], loss['gap_index']), loss, v)
        v.require((loss['ordinal_start'] < window['ordinal_hi'] and loss['ordinal_end'] > window['ordinal_lo'])
                  or (loss['output_start'] < window['output_hi'] and loss['output_end'] > window['output_lo']),
                  'evidence_conflict')
    if not v.errors:
        _position_causal_laws(native, v)
    if v.errors:
        raise _PositionInputError(v.first())
    normalized = deepcopy(value)
    normalized.pop('observation_id')
    normalized['runs'] = [deepcopy(runs[key]) for key in ordered]
    normalized['positions'] = [deepcopy(positions[key]) for key in ordered]
    normalized['losses'] = [deepcopy(losses[key]) for key in sorted(losses)]
    normalized['snapshot']['members'].sort(key=lambda member: member['track_id'])
    digest = _position_content_digest(normalized)
    if verify_digest and value['observation_id'] != digest:
        raise _PositionInputError('evidence_conflict')
    normalized['observation_id'] = digest
    return normalized


def _seal_album_position_observation(value):
    """Internal adapter content identity, not a proof or authority capability."""
    try:
        return _prepare_album_position_observation(value, verify_digest=False)
    except _PositionInputError as error:
        return _failure(error.args[0])


def _position_partition(value):
    runs, positions, window = value['runs'], value['positions'], value['window']
    members = {m['track_id']: m for m in value['snapshot']['members']}
    order = {track: i for i, track in enumerate(value['ordered_track_ids'])}
    reasons, groups, sequences = set(), [], []
    if not runs:
        reasons.add('no_positive_positions')
    elif (runs[0]['ordinal_start'] != window['ordinal_lo']
          or runs[-1]['ordinal_start'] + runs[-1]['frames'] != window['ordinal_hi']
          or runs[0]['output_start'] != window['output_lo']
          or runs[-1]['output_start'] + runs[-1]['frames'] != window['output_hi']):
        reasons.add('boundary_alignment_unknown')
    if value['losses']:
        reasons.add('reported_loss_overlap')
    if value['snapshot']['status'] != 'observed':
        reasons.add('snapshot_unavailable')
    for index, (run, pos) in enumerate(zip(runs, positions)):
        ref = dict(zip(('capture_parent_uuid', 'checkpoint_sequence', 'run_index'), _position_key(run)))
        same_group, extend, wrap = False, False, None
        if index:
            left, prior = runs[index - 1], positions[index - 1]
            adjacent = (left['ordinal_start'] + left['frames'] == run['ordinal_start']
                        and left['output_start'] + left['frames'] == run['output_start'])
            if not adjacent:
                reasons.add('positive_positions_missing')
            same_group = (adjacent and pos['generation'] == prior['generation']
                          and pos['continuity_serial'] == prior['continuity_serial'])
            if same_group:
                end = left['source_start48'] + left['frames']
                same_track = left['track_id'] == run['track_id']
                extent = members[left['track_id']]['media_extent_frames']
                next_track = order[run['track_id']] == order[left['track_id']] + 1
                album_wrap = (order[left['track_id']] == len(order) - 1
                              and order[run['track_id']] == 0)
                if same_track and run['source_start48'] == end:
                    extend = True
                elif same_track and run['source_start48'] < end:
                    wrap = 'source_wrap'
                elif (not same_track and extent is not None
                      and members[run['track_id']]['media_extent_frames'] is not None and end == extent
                      and run['source_start48'] == 0 and (next_track or album_wrap)):
                    extend = next_track
                    if not next_track:
                        wrap = 'album_wrap'
                else:
                    reasons.add('source_geometry_unknown')
        if not same_group:
            groups.append(dict(owner_id=value['owner']['owner_id'],
                continuity_serial=pos['continuity_serial'], generation=pos['generation'],
                run_refs=[], wraps=[], lifetime_start='unknown', lifetime_end='unknown'))
        groups[-1]['run_refs'].append(ref)
        if wrap:
            groups[-1]['wraps'].append(dict(kind=wrap, before_track_id=left['track_id'],
                after_track_id=run['track_id'], source_from48=end,
                source_to48=run['source_start48'], after=ref))
        if extend:
            sequences[-1].append(run)
        else:
            sequences.append([run])
    projection = dict(ordered_track_ids=value['ordered_track_ids'],
                      partition_status='unknown' if reasons else 'complete', reasons=sorted(reasons))
    return projection, sequences, groups


def compute_album_position_candidates(observation, target=5):
    """Observed N7 reported coordinates, never lifetime or hearing qualification.

    Authority, current inventory scope and immutable extent admission are external
    premises. The inventory-only reader intentionally supplies no exact extents.
    """
    try:
        value = _prepare_album_position_observation(observation, target)
        projection, sequences, groups = _position_partition(value)
        native, known, coverage = _raw_position_projection(value['snapshot'], value['runs'])
        batch = dict(actor_id=value['actor_id'], library_id=value['library_id'],
            local_album_key=value['selected_album']['local_album_key'],
            evidence_revision=value['observation_id'],
            scope=dict(kind='observed_window', owner=deepcopy(value['owner']),
                       window=deepcopy(value['window'])),
            snapshot=value['snapshot'], history=dict(status='partial', reasons=['history_partial']))
        result = _candidate_project(batch, projection, target, value['runs'], sequences,
                                    bool(projection['reasons']))
        result['metrics'].update(native_recorded_frames=_metric(native),
            native_recorded_seconds=_metric(_rational(Fraction(native, 48000))),
            known_position_frames=_metric(known), track_coverage=coverage,
            reported_lost_frames=_metric(reason='loss_time_unknown'))
        result.update(version=value['version'], observation_id=value['observation_id'],
            observation_status='complete_as_observed', timing_status='unknown',
            retirement_status='unknown', immutable_source_coverage_status='unknown',
            coordinate_basis='browser_reported_track_coordinates',
            measurement_protocol='app-rendered-position-v2',
            measurement_provenance='browser-reported-rendered-positions', history_status='partial',
            non_additive_across_observations=True,
            raw_interval_scope='whole_ordinal_intersecting_runs',
            uninterrupted_full_basis='observed_window_monotone_continuous_output_passes',
            observed_continuity_groups=groups,
            observed_runs=value['runs'], observed_positions=value['positions'],
            observed_losses=value['losses'])
        return result
    except _PositionInputError as error:
        return _failure(error.args[0])
    except OverflowError:
        return _failure('resource_limit')
    except ValueError as error:
        if error.args == ('candidate_geometry_conflict',):
            return _failure('evidence_conflict')
        raise



def compute_local_edition_recorded_metrics(members, runs):
    """Actual local reader projection; supported intervals, never imported counts.

    Caller supplies current complete membership and server-associated versions.
    Distinct file versions never share intervals. This first visible projection
    does not yet allocate Full/partial sessions or assert lifetime completeness.
    """
    if (type(members) is not list or not 1 <= len(members) <= 512
            or type(runs) is not list or len(runs) > 4096):
        return {'status':'unavailable','reason':'resource_limit'}
    ids=[m.get('track_id') for m in members if type(m) is dict]
    if len(ids)!=len(members) or len(set(ids))!=len(ids) or any(not _is_integer(i,1) for i in ids):
        return {'status':'unavailable','reason':'invalid_membership'}
    per_track={identity:dict(recorded_frames=0,versions={}) for identity in ids}
    total=0;unknown=0
    for run in runs:
        if type(run) is not dict or run.get('track_id') not in per_track:
            return {'status':'unavailable','reason':'invalid_run'}
        frames=run.get('frames');start=run.get('source_start48')
        if not _is_integer(frames,1) or not _is_integer(start,0):
            return {'status':'unavailable','reason':'invalid_run'}
        total+=frames;entry=per_track[run['track_id']];entry['recorded_frames']+=frames
        if total>9007199254740991:return {'status':'unavailable','reason':'resource_limit'}
        version=run.get('local_version');extent=run.get('extent_frames48')
        if (type(version) is not str or re.fullmatch('[a-f0-9]{64}',version) is None
                or not _is_integer(extent,1) or start+frames>extent):
            unknown+=1;continue
        group=entry['versions'].setdefault(version,dict(extent=extent,ranges=[]))
        if group['extent']!=extent:return {'status':'unavailable','reason':'conflicting_extent'}
        group['ranges'].append((start,start+frames))
    tracks=[]
    for member in members:
        identity=member['track_id'];entry=per_track[identity];best=None
        for version,group in entry['versions'].items():
            covered=0;end=0
            for lo,hi in sorted(group['ranges']):
                covered+=max(0,hi-max(lo,end));end=max(end,hi)
            candidate=(Fraction(covered,group['extent']),covered,group['extent'])
            if best is None or candidate[0]>best[0]:best=candidate
        tracks.append(dict(track_id=str(identity),recorded_frames=entry['recorded_frames'],
            covered_frames=None if best is None else best[1],
            extent_frames48=None if best is None else best[2],
            coverage_status='unknown' if best is None else 'supported_lower_bound'))
    return dict(status='partial',recorded_frames=total,tracks=tracks,
        tracks_with_supported_coverage=sum(t['coverage_status']!='unknown' for t in tracks),
        unsupported_run_count=unknown,full=None,listened='unknown',
        history_status='partial',basis='local-edition-recorded-v1')


LOCAL_FULL_POLICY = 'local-edition-overlap-total-margin-v1'


