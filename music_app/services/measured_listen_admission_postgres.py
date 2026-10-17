"""Dormant decoder-instance persistence. No routes, decoder or provider wiring.

record_observation is SERVER ONLY: its input must be an actual decoder snapshot.
A dataclass, UUID or this function's existence grants no observation authority.
No source-content equivalence or automatic completion is inferred. Callers must
choose a resource cap and resolve mutation detection before runtime activation.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json

from music_app.services import measured_listen_admission as admission
from music_app.services import measured_listen_evidence as evidence
from music_app.services.measured_listen_history import (
    measured_identity, lock_measured_identity, lock_measured_track_file,
)

_REASONS = frozenset(('eos', 'cancelled', 'replaced', 'shutdown', 'error', 'source_changed'))
_METADATA_FIELDS = frozenset(('metadata_revision', 'observed_intervals', 'extent_state',
                             'verified_total_frames', 'extent_provenance', 'admission_limited'))
_ACCEPTED_FIELDS = ('accepted_checkpoint', 'accepted_admission', 'accepted_digest',
                    'accepted_sequence', 'receipt_body', 'receipt_status', 'accepted_at')


class AdmissionPersistenceError(ValueError):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code, self.status = code, status


@dataclass(frozen=True)
class PersistenceResult:
    kind: str
    status: int
    body: str


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False)


def _now(clock):
    value = clock()
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise AdmissionPersistenceError('invalid_clock', 503)
    return value.astimezone(timezone.utc)


def _stored_time(value):
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('stored_time')
    return value.astimezone(timezone.utc)


@contextmanager
def _authority_transaction(database_url, context, *, connect, clock):
    # Lazy existing owners keep module import free of app/config initialization.
    from music_app.services.private_library_authority import current_library_transaction, require_private_action
    with current_library_transaction(database_url, context, connect=connect, clock=clock) as (connection, live, _):
        require_private_action(live, 'library.media.read')
        yield connection, live


def _final_authority(connection, live, *, clock, cancelled):
    from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
    from music_app.services.private_library_authority import require_private_action
    now = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                                     actor_session_id=live.actor.session_id, clock=clock)
    require_private_action(live, 'library.media.read')
    if cancelled():
        raise AdmissionPersistenceError('request_cancelled', 409)
    return _now(lambda: now)


def _scope(live):
    return (evidence._integer(live.actor.account_id, 1), evidence._integer(live.library_id, 1))


def _metadata_payload(metadata):
    admission.validate_admission(metadata)
    return {'metadata_revision': metadata.metadata_revision,
            'observed_intervals': [list(pair) for pair in metadata.observed_intervals],
            'extent_state': metadata.extent_state,
            'verified_total_frames': metadata.verified_total_frames,
            'extent_provenance': metadata.extent_provenance,
            'admission_limited': metadata.admission_limited}


def _decode_metadata(value, identity):
    if not isinstance(value, dict) or set(value) != _METADATA_FIELDS:
        raise AdmissionPersistenceError('stored_admission_invalid', 503)
    ranges = evidence._pairs(value['observed_intervals'], evidence.MAX_INTERVALS)
    return admission.validate_admission(admission.AdmissionMetadata(
        identity, value['metadata_revision'], ranges, value['extent_state'],
        value['verified_total_frames'], value['extent_provenance'], value['admission_limited']))


def _receipt(checkpoint, metadata, digest):
    return _json({'ok': True, 'decoder_instance_id': metadata.identity.decoder_instance_id,
                  'device_id': checkpoint.device_id, 'session_id': checkpoint.session_id,
                  'checkpoint_sequence': checkpoint.checkpoint_sequence, 'digest': digest,
                  'metadata_revision': metadata.metadata_revision, 'extent_state': metadata.extent_state,
                  'verified_total_frames': metadata.verified_total_frames,
                  'extent_provenance': metadata.extent_provenance, 'observation_provenance': 'decoded',
                  'admission_limited': metadata.admission_limited, 'finalized': checkpoint.finalized})


def _read_state(row):
    """Revalidate persisted facts and exact original receipt, not just JSON types."""
    try:
        identity = admission.AdmissionIdentity(
            evidence.EvidenceScope(row['account_id'], row['original_library_id'], row['original_track_id']),
            str(row['device_id']), str(row['session_id']), row['sample_rate'], str(row['decoder_instance_id']))
        evidence._integer(row['original_file_id'], 1)
        if row['evidence_version'] != evidence.VERSION:
            raise ValueError('version')
        latest = _decode_metadata(row['current_admission'], identity)
        admitted_at = _stored_time(row['admitted_at'])
        if not latest.observed_intervals:
            raise ValueError('empty_admission')
        state, reason = row['lifecycle_state'], row['retirement_reason']
        if state == 'open':
            if reason is not None or row['retired_at'] is not None:
                raise ValueError('lifecycle')
        elif state == 'retired':
            if reason not in _REASONS or row['retired_at'] is None:
                raise ValueError('lifecycle')
            if _stored_time(row['retired_at']) < admitted_at:
                raise ValueError('lifecycle_time')
        else:
            raise ValueError('lifecycle')
        if latest.extent_state == 'verified_complete' and (state != 'retired' or reason != 'eos'):
            raise ValueError('verified_lifecycle')
        values = [row[name] for name in _ACCEPTED_FIELDS]
        if all(value is None for value in values):
            return latest, None
        if any(value is None for value in values):
            raise ValueError('accepted_shape')
        if _stored_time(row['accepted_at']) < admitted_at:
            raise ValueError('accepted_time')
        saved_metadata = _decode_metadata(row['accepted_admission'], identity)
        if not saved_metadata.observed_intervals:
            raise ValueError('empty_accepted_admission')
        admission.compare_admission(saved_metadata, latest)
        checkpoint = admission.normalize_admitted_checkpoint(row['accepted_checkpoint'], saved_metadata)
        digest = admission.admitted_checkpoint_digest(checkpoint, identity)
        if (row['accepted_digest'] != digest or type(row['accepted_sequence']) is not int
                or row['accepted_sequence'] != checkpoint.checkpoint_sequence
                or type(row['receipt_status']) is not int or row['receipt_status'] != 200
                or row['receipt_body'] != _receipt(checkpoint, saved_metadata, digest)):
            raise ValueError('receipt')
        return latest, admission.AcceptedEvidence(saved_metadata, checkpoint, digest)
    except (KeyError, TypeError, ValueError, AttributeError):
        raise AdmissionPersistenceError('stored_admission_invalid', 503) from None


def _row(connection, account_id, library_id, device_id, session_id, decoder_id):
    return connection.execute('''select * from integration.measured_listen_admission
        where account_id=%s and original_library_id=%s and device_id=%s and session_id=%s
          and decoder_instance_id=%s for update''',
        (account_id, library_id, device_id, session_id, decoder_id)).fetchone()


def _current_file(connection, library_id, private_path):
    if not isinstance(private_path, str) or not private_path or len(private_path) > 32768:
        raise AdmissionPersistenceError('invalid_media_path', 400)
    track = lock_measured_track_file(connection, library_id, private_path)
    if track is None:
        raise AdmissionPersistenceError('source_unavailable', 403)
    evidence._integer(track['id'], 1)
    evidence._integer(track['file_id'], 1)
    return track


def _match_source(row, track, library_id):
    if (row['original_track_id'] != track['id'] or row['original_file_id'] != track['file_id']
            or row['live_library_id'] != library_id or row['live_track_id'] != track['id']
            or row['live_file_id'] != track['file_id']):
        raise AdmissionPersistenceError('source_unavailable', 403)


def record_observation(database_url, context, metadata, private_path, *, max_instances,
                       cancelled, retirement_reason=None, connect=None, clock=None):
    """Server-only first-output/update/retirement operation; never client creation.

    max_instances is required: this dormant service does not choose product policy.
    cancelled must report REQUEST invalidation; a retirement flush may contain only
    observations captured before decoder cancellation. Caller owns that distinction.
    """
    admission.validate_admission(metadata)
    evidence._integer(max_instances, 1)
    if not callable(cancelled):
        raise AdmissionPersistenceError('cancellation_fence_required', 400)
    if retirement_reason is not None and retirement_reason not in _REASONS:
        raise AdmissionPersistenceError('invalid_retirement', 400)
    if metadata.extent_state == 'verified_complete' and retirement_reason != 'eos':
        raise AdmissionPersistenceError('invalid_retirement', 400)
    clock = clock or (lambda: datetime.now(timezone.utc))
    identity = metadata.identity
    with _authority_transaction(database_url, context, connect=connect, clock=clock) as (connection, live):
        account_id, library_id = _scope(live)
        if (identity.scope.account_id, identity.scope.library_id) != (account_id, library_id):
            raise AdmissionPersistenceError('admission_scope_mismatch', 403)
        lock_measured_identity(connection, measured_identity(account_id, library_id, identity.device_id, identity.session_id))
        track = _current_file(connection, library_id, private_path)
        if identity.scope.track_id != track['id']:
            raise AdmissionPersistenceError('admission_scope_mismatch', 403)
        row = _row(connection, account_id, library_id, identity.device_id, identity.session_id, identity.decoder_instance_id)
        if row is None:
            if not metadata.observed_intervals:
                raise AdmissionPersistenceError('admission_not_ready', 409)
            group = connection.execute('''select count(*) as instance_count, min(original_track_id) as first_track_id,
                max(original_track_id) as last_track_id from integration.measured_listen_admission
                where account_id=%s and original_library_id=%s and device_id=%s and session_id=%s''',
                (account_id, library_id, identity.device_id, identity.session_id)).fetchone()
            count = evidence._integer(group['instance_count'])
            if count and (group['first_track_id'] != track['id'] or group['last_track_id'] != track['id']):
                raise AdmissionPersistenceError('logical_session_track_changed', 409)
            if count >= max_instances:
                raise AdmissionPersistenceError('admission_resource_limit', 409)
        else:
            _match_source(row, track, library_id)
            latest, _ = _read_state(row)
            admission.compare_admission(latest, metadata)
            if row['lifecycle_state'] == 'retired' and (
                    metadata != latest or retirement_reason != row['retirement_reason']):
                raise AdmissionPersistenceError('decoder_retired', 409)
        # Locks protect these rows, but repeat the exact lookup after all waits.
        if _current_file(connection, library_id, private_path) != track:
            raise AdmissionPersistenceError('source_unavailable', 403)
        now = _final_authority(connection, live, clock=clock, cancelled=cancelled)
        if row is not None and now < _stored_time(row['admitted_at']):
            raise AdmissionPersistenceError('invalid_clock', 503)
        state = 'retired' if retirement_reason is not None else 'open'
        serialized = _json(_metadata_payload(metadata))
        wrote = False
        if row is None:
            connection.execute('''insert into integration.measured_listen_admission
                (decoder_instance_id,account_id,original_library_id,original_track_id,original_file_id,
                 live_library_id,live_track_id,live_file_id,device_id,session_id,evidence_version,
                 sample_rate,admitted_at,current_admission,lifecycle_state,retirement_reason,retired_at)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s)''',
                (identity.decoder_instance_id, account_id, library_id, track['id'], track['file_id'],
                 library_id, track['id'], track['file_id'], identity.device_id, identity.session_id,
                 evidence.VERSION, identity.sample_rate, now, serialized, state, retirement_reason,
                 now if retirement_reason is not None else None))
            wrote = True
        elif metadata != latest or state != row['lifecycle_state']:
            connection.execute('''update integration.measured_listen_admission set current_admission=%s::jsonb,
                lifecycle_state=%s,retirement_reason=%s,retired_at=%s where decoder_instance_id=%s''',
                (serialized, state, retirement_reason, now if retirement_reason is not None else None, identity.decoder_instance_id))
            wrote = True
        if cancelled():
            raise AdmissionPersistenceError('request_cancelled', 409)
        if wrote:
            # A write can wait (including global decoder uniqueness). The
            # pre-write timestamp is admission history, not final authority.
            _final_authority(connection, live, clock=clock, cancelled=cancelled)
        return metadata


def record_checkpoint(database_url, context, decoder_instance_id, payload, private_path, *,
                      cancelled, connect=None, clock=None):
    """Accept evidence only for an already durable server-observed instance.

    Returns after commit. Same-instance retired rows allow delayed evidence;
    current source and live account/session authority are still mandatory. This
    is not account-only historical receipt recovery after source loss.
    """
    decoder_id = evidence._uuid(decoder_instance_id)
    if not isinstance(payload, dict):
        raise AdmissionPersistenceError('invalid_checkpoint', 400)
    device_id, session_id = evidence._uuid(payload.get('device_id')), evidence._uuid(payload.get('session_id'))
    if not callable(cancelled):
        raise AdmissionPersistenceError('cancellation_fence_required', 400)
    clock = clock or (lambda: datetime.now(timezone.utc))
    with _authority_transaction(database_url, context, connect=connect, clock=clock) as (connection, live):
        account_id, library_id = _scope(live)
        lock_measured_identity(connection, measured_identity(account_id, library_id, device_id, session_id))
        track = _current_file(connection, library_id, private_path)
        row = _row(connection, account_id, library_id, device_id, session_id, decoder_id)
        if row is None:
            raise AdmissionPersistenceError('admission_not_ready', 409)
        _match_source(row, track, library_id)
        latest, previous = _read_state(row)
        # Shape validation does not invent a moving total; compare validates NEW
        # evidence against latest ranges and replays against the original snapshot.
        incoming = evidence._normalize_checkpoint(payload, latest.identity.sample_rate, evidence.MAX_INTEGER)
        decision = admission.compare_admitted_checkpoint(previous, incoming, latest)
        if _current_file(connection, library_id, private_path) != track:
            raise AdmissionPersistenceError('source_unavailable', 403)
        now = _final_authority(connection, live, clock=clock, cancelled=cancelled)
        if now < _stored_time(row['admitted_at']):
            raise AdmissionPersistenceError('invalid_clock', 503)
        wrote = False
        if decision.kind == 'replay':
            result = PersistenceResult('replay', row['receipt_status'], row['receipt_body'])
        elif decision.kind == 'stale':
            result = PersistenceResult('stale', 409, _json({'ok': False, 'error': 'stale_checkpoint',
                'latest_sequence': previous.checkpoint.checkpoint_sequence,
                'decoder_instance_id': decoder_id}))
        else:
            receipt = _receipt(incoming, latest, decision.digest)
            connection.execute('''update integration.measured_listen_admission set
                accepted_checkpoint=%s::jsonb,accepted_admission=%s::jsonb,accepted_digest=%s,
                accepted_sequence=%s,receipt_body=%s,receipt_status=%s,accepted_at=%s
                where decoder_instance_id=%s''',
                (_json(incoming.wire()), _json(_metadata_payload(latest)), decision.digest,
                 incoming.checkpoint_sequence, receipt, 200, now, decoder_id))
            wrote = True
            result = PersistenceResult('accept', 200, receipt)
        if cancelled():
            raise AdmissionPersistenceError('request_cancelled', 409)
        if wrote:
            # Preserve accepted_at while reauthorizing after any write wait.
            _final_authority(connection, live, clock=clock, cancelled=cancelled)
    return result
