"""Bounded, identity-free application-reported playback evidence.

These assertions are neither decoder attestation nor proof of human listening.
This module performs no I/O and deliberately imports no application config.
"""
import hashlib
import hmac
import json
from collections.abc import Mapping
from uuid import UUID

PROTOCOL = 'app-rendered-position-v1'
MAX_INTEGER = 9_007_199_254_740_991
BODY_LIMIT = 32_768
MAX_TRACK_PATH_CHARACTERS = 32_768
TERMINAL_REASONS = frozenset(('ended', 'stopped', 'track_change', 'owner_closed',
                              'capture_limit', 'transport_abandoned', 'error'))
GAP_REASONS = frozenset(('buffer_credit', 'queue_capacity', 'binding_capacity',
                       'timing_discontinuity', 'owner_reset', 'numeric_limit'))


class CaptureError(ValueError):
    def __init__(self, code='invalid_capture', status=400):
        super().__init__(code)
        self.code = code
        self.status = status


def _object(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        raise CaptureError()
    return value


def _integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_INTEGER:
        raise CaptureError()
    return value


def _uuid(value):
    if type(value) is not str:
        raise CaptureError()
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError):
        raise CaptureError() from None
    if str(parsed) != value:
        raise CaptureError()
    return value


def _array(value, limit):
    if type(value) is not list or len(value) > limit:
        raise CaptureError()
    return value


def _quality(value):
    if value not in ('unknown', 'bounded') or type(value) is not str:
        raise CaptureError()
    return value


def _anchor_ref(value, epoch):
    if value is None:
        return None
    if type(value) is not list or len(value) != 2:
        raise CaptureError()
    if _integer(value[0], 1) != epoch:
        raise CaptureError()
    return [epoch, _integer(value[1], 1)]


def _run(value):
    keys = ('source_start48', 'frames', 'output_start', 'ordinal_start', 'epoch',
            'anchor_before', 'anchor_after', 'quality')
    _object(value, keys)
    result = {key: _integer(value[key], 1 if key in ('frames', 'epoch') else 0)
              for key in keys[:5]}
    for key in ('source_start48', 'output_start', 'ordinal_start'):
        _integer(result[key] + result['frames'])
    result.update({key: _anchor_ref(value[key], result['epoch'])
                   for key in ('anchor_before', 'anchor_after')})
    result['quality'] = _quality(value['quality'])
    if result['quality'] == 'bounded' and (result['anchor_before'] is None or result['anchor_after'] is None):
        raise CaptureError()
    return result


def _anchor(value):
    keys = ('epoch', 'probe_id', 'output_frame', 'utc_lower_ms', 'utc_upper_ms',
            'monotonic_probe_span_ms', 'max_quantum_frames', 'quality')
    _object(value, keys)
    result = {key: _integer(value[key], 1 if key in ('epoch', 'probe_id', 'max_quantum_frames') else 0)
              for key in keys if key not in ('utc_lower_ms', 'utc_upper_ms', 'quality')}
    result['quality'] = _quality(value['quality'])
    lo, hi = value['utc_lower_ms'], value['utc_upper_ms']
    if result['quality'] == 'bounded':
        _integer(lo, -MAX_INTEGER); _integer(hi, -MAX_INTEGER)
        if lo > hi or result['max_quantum_frames'] > 2048 or result['monotonic_probe_span_ms'] > 250:
            raise CaptureError()
    elif lo is not None or hi is not None:
        raise CaptureError()
    result.update(utc_lower_ms=lo, utc_upper_ms=hi)
    return result


def _gap(value):
    keys = ('ordinal_start', 'ordinal_end', 'positive_frames', 'output_start', 'output_end', 'epoch', 'reasons')
    _object(value, keys)
    result = {key: _integer(value[key], 1 if key == 'positive_frames' else 0) for key in keys[:-1] if key != 'epoch'}
    result['epoch'] = None if value['epoch'] is None else _integer(value['epoch'], 1)
    reasons = _array(value['reasons'], len(GAP_REASONS))
    if not reasons or any(type(r) is not str or r not in GAP_REASONS for r in reasons) or reasons != sorted(set(reasons)):
        raise CaptureError()
    if (result['ordinal_end'] - result['ordinal_start'] < result['positive_frames']
            or result['output_end'] - result['output_start'] < result['positive_frames']):
        raise CaptureError()
    result['reasons'] = list(reasons)
    return result


def normalize_capture_envelope(value):
    """Validate the complete schema and return a fresh bounded canonical value."""
    _object(value, ('protocol', 'device_uuid', 'capture_uuid', 'sequence', 'evidence'),
            ('v1_session_uuid', 'initial_path'))
    if value['protocol'] != PROTOCOL:
        raise CaptureError('unsupported_capture_version')
    evidence = _object(value['evidence'], ('runs', 'anchors', 'gaps', 'terminal', 'terminal_reason'))
    runs = [_run(row) for row in _array(evidence['runs'], 256)]
    anchors = [_anchor(row) for row in _array(evidence['anchors'], 8)]
    gaps = [_gap(row) for row in _array(evidence['gaps'], 8)]
    if type(evidence['terminal']) is not bool:
        raise CaptureError()
    reason = evidence['terminal_reason']
    if evidence['terminal']:
        if type(reason) is not str or reason not in TERMINAL_REASONS:
            raise CaptureError()
    elif reason is not None:
        raise CaptureError()
    if not runs and not gaps and not anchors and not evidence['terminal']:
        raise CaptureError()
    for before, after in zip(runs, runs[1:]):
        if before['ordinal_start'] + before['frames'] > after['ordinal_start'] or before['output_start'] + before['frames'] > after['output_start']:
            raise CaptureError()
    # Loss envelopes are not continuous missing ranges. They can overlap runs
    # and earlier summaries; exact positive counts are app assertions, applied
    # once under immutable parent/sequence identity.
    if len({(a['epoch'], a['probe_id']) for a in anchors}) != len(anchors):
        raise CaptureError()
    _integer(sum(r['frames'] for r in runs) + sum(g['positive_frames'] for g in gaps))
    normalized = dict(protocol=PROTOCOL, device_uuid=_uuid(value['device_uuid']),
                      capture_uuid=_uuid(value['capture_uuid']), sequence=_integer(value['sequence'], 1),
                      evidence=dict(runs=runs, anchors=anchors, gaps=gaps,
                                    terminal=evidence['terminal'], terminal_reason=reason))
    if 'v1_session_uuid' in value:
        normalized['v1_session_uuid'] = _uuid(value['v1_session_uuid'])
    if 'initial_path' in value:
        path = value['initial_path']
        if type(path) is not str or not path or '\x00' in path or len(path) > MAX_TRACK_PATH_CHARACTERS:
            raise CaptureError()
        try:
            path.encode('utf-8')
        except UnicodeEncodeError:
            raise CaptureError() from None
        normalized['initial_path'] = path
    if len(canonical_json(normalized).encode('utf-8')) > BODY_LIMIT:
        raise CaptureError('capture_too_large', 413)
    return normalized


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def capture_digest(sequence, evidence):
    return hashlib.sha256(f'{PROTOCOL}\n{sequence}\n{canonical_json(evidence)}'.encode('utf-8')).hexdigest()


def parse_capture_body(raw):
    if len(raw) > BODY_LIMIT:
        raise CaptureError('capture_too_large', 413)
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise CaptureError()
            result[key] = value
        return result
    def invalid(_):
        raise CaptureError()
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid,
                           parse_float=invalid)
    except (UnicodeError, ValueError, RecursionError):
        raise CaptureError() from None
    return normalize_capture_envelope(value)


def capture_scope(context, auth_policy_config):
    """Opaque consistency guard; this never replaces current authorization."""
    config = auth_policy_config if isinstance(auth_policy_config, Mapping) else {}
    settings = config.get('hmac')
    secret = settings.get('secret') if isinstance(settings, Mapping) else None
    version = settings.get('key_version') if isinstance(settings, Mapping) else None
    if not isinstance(secret, str) or len(secret.encode('utf-8')) < 32:
        raise RuntimeError('Policy resource-key configuration is invalid.')
    ids = (context.actor.account_id, context.library_id, context.actor.session_id)
    if any(type(value) is not int or value <= 0 for value in ids):
        raise CaptureError('capture_forbidden', 403)
    message = 'album-haven:playback-capture-scope:v1\0' + canonical_json(list(ids))
    digest = hmac.new(secret.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest()
    return f'v{int(version or 1)}:{digest}'
