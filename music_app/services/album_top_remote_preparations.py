"""Bounded private preparations; no membership or public authority.

Provider work follows a proven reservation commit and runs outside transactions.
An unknown commit acknowledgement cannot recover dispatch rights. The existing
transport owns pacing/retries; no attempt takes an expired reservation over.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import math

from music_app.services.album_top_remote_acquisition import remote_storage_error
from music_app.services.album_top_remote_sources import (
    PreparedRemoteTopAcquisitionCommand, evidence_from_row, normalize_remote_preparation,
    normalize_remote_maintenance, project_remote_summary, remote_context_ref,
    remote_preparation_ref,
)
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, CREATE
from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError, validate_release_group_evidence


_FAILURE_CODES = frozenset({'provider_unavailable', 'invalid_provider_metadata', 'provider_identity_changed'})
_CAPACITY_FIELDS = frozenset({'legacy_initialized', 'legacy_inspected', 'counts_complete',
    'actor_pending_count', 'actor_pending_bytes', 'actor_reservations', 'physical_parents',
    'actor_pending_slots_available', 'actor_pending_bytes_available', 'actor_reservation_slots_available',
    'physical_parent_slots_available', 'attempt_slots_remaining', 'pending_slots_available',
    'pending_bytes_available', 'reservation_slots_available', 'worst_case_new_acquisitions'})
_PARENT_CAPACITY_FIELDS = frozenset({'attempt_slots_remaining', 'pending_slots_available',
    'pending_bytes_available', 'reservation_slots_available'})
_BINDING_FIELDS = ('library_id', 'actor_account_id', 'original_session_id', 'context_ref',
    'destination_kind', 'destination_ref', 'destination_owner_account_id', 'destination_revision')


def _require_snapshot(condition):
    if not condition:
        raise AlbumTopError('remote_acquisition_unavailable', 503)


def _cancel(callback):
    if callback is not None:
        if not callable(callback):
            raise AlbumTopError('invalid_command')
        if callback():
            raise AlbumTopError('provider_cancelled', 503)


def _monotonic(clock):
    try:
        value = clock()
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('Invalid monotonic value')
        return float(value)
    except (TypeError, ValueError, OverflowError):
        raise AlbumTopError('remote_acquisition_unavailable', 503) from None


def _timestamp(value):
    try:
        if type(value) is not str or len(value) > 64:
            raise ValueError('Invalid SQL time')
        result = datetime.fromisoformat(value)
        if result.tzinfo is None or result.utcoffset() is None:
            raise ValueError('SQL time must have a timezone')
        return result.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        raise AlbumTopError('remote_acquisition_unavailable', 503) from None


def _ref(value):
    try:
        return remote_preparation_ref(value)
    except AlbumTopError:
        raise AlbumTopError('remote_acquisition_unavailable', 503) from None


def _count(value, maximum=(2 ** 63 - 1)):
    _require_snapshot(type(value) is int and 0 <= value <= maximum)
    return value


def _capacity(value):
    _require_snapshot(type(value) is dict and set(value) == _CAPACITY_FIELDS)
    result = {}
    for name in _CAPACITY_FIELDS:
        item = value[name]
        if name in {'legacy_initialized', 'counts_complete'}:
            _require_snapshot(type(item) is bool)
            result[name] = item
        elif name in _PARENT_CAPACITY_FIELDS and item is None:
            result[name] = None
        else:
            result[name] = _count(item)
    _require_snapshot(result['counts_complete'] == result['legacy_initialized'])
    return result


def _parent(value):
    _require_snapshot(type(value) is dict and value.get('state') in {'ready', 'accepting', 'draining', 'expired', 'closed'})
    created = _timestamp(value.get('created_at'))
    accepts, expires = _timestamp(value.get('accepts_until')), _timestamp(value.get('fully_expires_at'))
    _require_snapshot(accepts == created + timedelta(minutes=30) and expires == created + timedelta(minutes=60))
    result = {'preparation_ref': _ref(value.get('preparation_ref')), 'form_ref': _ref(value.get('form_ref')),
        'state': value['state'], 'created_at': created.isoformat(), 'accepts_until': accepts.isoformat(),
        'fully_expires_at': expires.isoformat(), 'attempt_count': _count(value.get('attempt_count'), 512),
        'pending_count': _count(value.get('pending_count'), 512), 'pending_bytes': _count(value.get('pending_bytes'), 8388608),
        'reservation_count': _count(value.get('reservation_count'), 2), 'capacity': _capacity(value.get('capacity'))}
    _require_snapshot(result['reservation_count'] <= result['pending_count'] <= result['attempt_count'])
    return result


def _sql(connection, name, params):
    # Names are literal internal calls below, never a request field. Map only
    # this structural family's known refusals; cancellation is not Exception.
    statement = 'select app.' + name + '(' + ','.join(['%s'] * len(params)) + ') as snapshot'
    try:
        result = connection.execute(statement, params).fetchone()
    except Exception as error:
        translated = remote_storage_error(error)
        if translated is not None:
            raise translated from None
        raise
    _require_snapshot(result is not None and type(result.get('snapshot')) is dict)
    return result['snapshot']


class RemoteTopPreparationService:
    def __init__(self, acquisition):
        self.acquisition = acquisition
        self.owner = acquisition.owner

    @staticmethod
    def _scope(live, destination, owner, context_ref):
        return (live.library_id, live.actor.account_id, live.actor.session_id, context_ref,
                destination.kind, destination.ref, owner,
                int(destination.revision) if destination.revision is not None else None)

    def _attempt_args(self, live, top, command, context_ref):
        return (command.preparation_ref, *self._scope(live, command.destination,
            self.acquisition._owner(live, top), context_ref), command.request_key,
            command.digest, command.release_group_id)

    @contextmanager
    def _own_state(self, context, context_ref, constraints, should_cancel):
        remote_context_ref(context_ref)
        _cancel(should_cancel)
        with self.owner._authorized(context, constraints) as (connection, live, _):
            self.owner._require(live, (BROWSE,), constraints)
            yield connection, live
            _cancel(should_cancel)
            # Cancellation observers may change current policy; the actual
            # owner's exit also rechecks the live session before commit.
            self.owner._require(live, (BROWSE,), constraints)

    @staticmethod
    def _refusal(value, context_ref):
        _require_snapshot(value.get('state') in {'maintenance_required', 'limit'}
            and value.get('resource') in {'legacy_initialization', 'parents', 'attempts', 'reservations', 'pending'})
        return {'version': 2, 'context_ref': context_ref, 'state': value['state'], 'resource': value['resource'],
                'error': 'remote_preparation_maintenance_required' if value['state'] == 'maintenance_required' else 'remote_acquisition_limit',
                'capacity': _capacity(value.get('capacity'))}

    def begin(self, context, *, payload, context_ref, constraints=None, should_cancel=None):
        destination, form_ref = normalize_remote_preparation(payload)
        context_ref = remote_context_ref(context_ref)
        owner = self.acquisition._discover_owner(context, destination, constraints, should_cancel)
        with self.acquisition._authorized(context, destination, constraints, should_cancel,
                write=True, discovered_owner=owner, budget_lock=True) as (connection, live, top):
            value = _sql(connection, 'begin_top_remote_preparation',
                (*self._scope(live, destination, self.acquisition._owner(live, top), context_ref), form_ref))
            if value.get('state') in {'maintenance_required', 'limit'}:
                return self._refusal(value, context_ref)
            result = _parent(value)
            _require_snapshot(result['state'] == 'ready' and result['form_ref'] == form_ref)
            return {'version': 2, 'context_ref': context_ref, 'destination': destination.payload(), **result}

    def status(self, context, *, context_ref, constraints=None, should_cancel=None):
        with self._own_state(context, context_ref, constraints, should_cancel) as (connection, live):
            value = _sql(connection, 'status_top_remote_preparations', (live.actor.account_id, live.library_id))
            _require_snapshot(value.get('state') == 'status' and type(value.get('parents')) is list
                and len(value['parents']) <= 32 and type(value.get('maintenance_required')) is bool)
            parents = [_parent(item) for item in value['parents']]
            _require_snapshot(len({item['preparation_ref'] for item in parents}) == len(parents)
                and all(item['state'] != 'ready' for item in parents))
            return {'version': 2, 'context_ref': context_ref, 'state': 'status',
                'sql_now': _timestamp(value.get('sql_now')).isoformat(), 'capacity': _capacity(value.get('capacity')),
                'parents': parents, 'maintenance_required': value['maintenance_required']}

    def close(self, context, *, preparation_ref, payload, context_ref, constraints=None, should_cancel=None):
        preparation_ref = remote_preparation_ref(preparation_ref)
        if type(payload) is not dict or payload:
            raise AlbumTopError('invalid_command')
        with self._own_state(context, context_ref, constraints, should_cancel) as (connection, live):
            value = _sql(connection, 'close_top_remote_preparation',
                         (live.actor.account_id, live.library_id, preparation_ref))
            _require_snapshot(value.get('state') == 'closed' and value.get('preparation_ref') == preparation_ref)
            return {'version': 2, 'context_ref': context_ref, 'state': 'closed', 'preparation_ref': preparation_ref,
                'removed_attempts': _count(value.get('removed_attempts'), 512),
                'removed_facts': _count(value.get('removed_facts'), 512),
                'released_bytes': _count(value.get('released_bytes'), 8388608), 'capacity': _capacity(value.get('capacity'))}

    def maintain(self, context, *, payload, context_ref, constraints=None, should_cancel=None):
        mode = normalize_remote_maintenance(payload)
        with self._own_state(context, context_ref, constraints, should_cancel) as (connection, live):
            value = _sql(connection, 'maintain_top_remote_preparations',
                         (live.actor.account_id, live.library_id, mode))
            _require_snapshot(value.get('state') in {'progress', 'complete'} and value.get('branch') in {
                'legacy_initialization', 'legacy_cleanup', 'discard_legacy', 'expired_reservations',
                'expired_facts', 'parent_reclamation', 'none'} and type(value.get('more_work')) is bool)
            return {'version': 2, 'context_ref': context_ref, 'state': value['state'], 'branch': value['branch'],
                'inspected': _count(value.get('inspected'), 1024), 'removed_facts': _count(value.get('removed_facts'), 512),
                'removed_attempts': _count(value.get('removed_attempts'), 512),
                'released_bytes': _count(value.get('released_bytes'), 8388608), 'more_work': value['more_work'],
                'capacity': _capacity(value.get('capacity'))}

    @staticmethod
    def _public_attempt(command, context_ref, value, scope):
        common = {'version': 2, 'context_ref': context_ref, 'preparation_ref': command.preparation_ref,
                  'request_key': command.request_key, 'destination': command.destination.payload()}
        state = value.get('state')
        if state in {'maintenance_required', 'limit'}:
            _require_snapshot(value.get('preparation_ref') == command.preparation_ref and value.get('dispatch') is False)
            return {**common, **RemoteTopPreparationService._refusal(value, context_ref)}
        _require_snapshot(tuple(value.get(name) for name in _BINDING_FIELDS) == scope
            and value.get('preparation_ref') == command.preparation_ref and value.get('request_key') == command.request_key
            and value.get('command_digest') == command.digest and value.get('external_id') == command.release_group_id
            and type(value.get('dispatch')) is bool)
        _ref(value.get('attempt_ref'))
        acquisition_ref = _ref(value.get('acquisition_ref'))
        checked = _timestamp(value.get('sql_now'))
        if checked >= _timestamp(value.get('fully_expires_at')):
            raise AlbumTopError('remote_preparation_unavailable', 409)
        if state == 'reserved':
            if checked >= min(_timestamp(value.get('lease_until')), _timestamp(value.get('accepts_until'))):
                raise AlbumTopError('remote_preparation_unavailable', 409)
            return {**common, 'state': 'in_flight', 'retry_after_seconds': 1}
        if state == 'failed':
            _require_snapshot(value.get('error_code') in _FAILURE_CODES and value.get('facts') is None)
            return {**common, 'state': 'failed', 'error': value['error_code']}
        if state == 'consumed':
            version = value.get('evidence_version')
            revision = value.get('consumed_revision')
            _require_snapshot(value.get('dispatch') is False and value.get('facts') is None
                and type(version) is str and len(version) == 64
                and all(character in '0123456789abcdef' for character in version)
                and type(revision) is int and 0 < revision <= 9223372036854775807)
            return {**common, 'state': 'consumed', 'acquisition_ref': acquisition_ref,
                    'evidence_version': version, 'consumed_top_ref': _ref(value.get('consumed_top_ref')),
                    'consumed_revision': str(revision), 'operation_request_key': _ref(value.get('operation_request_key'))}
        if state != 'pending':
            raise AlbumTopError('remote_preparation_unavailable', 409)
        row = value.get('facts')
        _require_snapshot(type(row) is dict and tuple(row.get(name) for name in _BINDING_FIELDS) == scope
            and row.get('ref') == acquisition_ref and row.get('preparation_ref') == command.preparation_ref
            and row.get('attempt_ref') == value['attempt_ref'] and row.get('request_key') == command.request_key
            and row.get('command_digest') == command.digest and row.get('external_id') == command.release_group_id
            and row.get('evidence_version') == value.get('evidence_version') and row.get('retired_at') is None)
        facts = evidence_from_row(row)
        created, expires = _timestamp(row.get('created_at')), _timestamp(row.get('expires_at'))
        if (expires - created != timedelta(minutes=30) or not created <= checked < expires
                or created >= _timestamp(value.get('accepts_until')) or expires > _timestamp(value.get('fully_expires_at'))):
            raise AlbumTopError('remote_preparation_unavailable', 409)
        return {**common, 'state': 'pending', 'acquisition_ref': acquisition_ref,
                'evidence_version': facts.digest, 'expires_at': expires.isoformat(),
                'album': project_remote_summary(facts)}

    def _discover_consumed_create(self, context, command, constraints, should_cancel):
        if command.destination.kind != 'create':
            return None
        self.owner._require(context, (BROWSE, CREATE), constraints)
        # Exact unlocked result hint only. The current result Top must be
        # independently locked/readable before parent or attempt locks below.
        with self.owner._connect(self.owner._url) as connection:
            row = connection.execute('''select a.consumed_top_ref from app.album_top_remote_attempts a
                join app.album_top_remote_preparations p on p.ref=a.preparation_ref and p.actor_account_id=a.actor_account_id
                where p.actor_account_id=%s and p.ref=%s and a.request_key=%s and a.state='consumed' ''',
                (context.actor.account_id, command.preparation_ref, command.request_key)).fetchone()
        _cancel(should_cancel)
        return _ref(str(row['consumed_top_ref'])) if row is not None else None

    def _read_consumed_create(self, context, command, context_ref, result_ref, constraints, should_cancel):
        _cancel(should_cancel)
        with self.owner._authorized(context, constraints) as (connection, live, _):
            self.owner._require(live, (BROWSE, CREATE), constraints)
            args = self._attempt_args(live, None, command, context_ref)
            # The fixed reader locks the existing budget before this exact Top,
            # then parent/attempt, without any initializer or state write. Its
            # private snapshot cannot escape before native current rights below.
            value = _sql(connection, 'read_top_remote_consumed_create', (*args, result_ref))
            _require_snapshot(value.get('state') == 'consumed' and value.get('consumed_top_ref') == result_ref)
            original_deadline = _timestamp(value.get('fully_expires_at'))
            top = self.owner._top(connection, live, result_ref, write=True)
            if top['owner_account_id'] != live.actor.account_id:
                raise AlbumTopError('top_unavailable', 404)
            _cancel(should_cancel)
            self.owner._require(live, (BROWSE, CREATE), constraints)
            self.owner._require(live, (BROWSE,), constraints, top)
            # Recheck the exact held identities and current SQL parent expiry
            # after native Top/policy work. Do not reuse an earlier timestamp or
            # discover a replacement result after any of these waits.
            value = _sql(connection, 'read_top_remote_consumed_create', (*args, result_ref))
            _require_snapshot(value.get('state') == 'consumed' and value.get('consumed_top_ref') == result_ref
                and _timestamp(value.get('fully_expires_at')) == original_deadline)
            self.owner._require(live, (BROWSE, CREATE), constraints)
            self.owner._require(live, (BROWSE,), constraints, top)
            # Final policy callbacks can themselves wait. Sample only SQL time
            # after them, without another target/lock/initializer, against this
            # exact held parent's original server deadline. Nothing after this
            # check invokes a policy/cancellation callback or reads a new target.
            final = connection.execute('select clock_timestamp()::text as checked_at').fetchone()
            _require_snapshot(final is not None)
            checked = _timestamp(final.get('checked_at'))
            _require_snapshot(checked >= _timestamp(value.get('sql_now')))
            if checked >= original_deadline:
                raise AlbumTopError('remote_preparation_unavailable', 409)
            value = dict(value, sql_now=checked.isoformat())
            return self._public_attempt(command, context_ref, value, args[1:9])

    def acquire(self, context, *, command, context_ref, constraints=None, should_cancel=None):
        if not isinstance(command, PreparedRemoteTopAcquisitionCommand):
            raise AlbumTopError('invalid_command')
        context_ref = remote_context_ref(context_ref)
        _cancel(should_cancel)
        # Anchor BEFORE discovery and all reservation/commit waits. A later
        # sample must never restart a fresh 120-second lease.
        anchor = _monotonic(self.acquisition.monotonic_clock)
        consumed_top = self._discover_consumed_create(context, command, constraints, should_cancel)
        if consumed_top is not None:
            return self._read_consumed_create(context, command, context_ref, consumed_top, constraints, should_cancel)
        owner = self.acquisition._discover_owner(context, command.destination, constraints, should_cancel)
        with self.acquisition._authorized_prepared_attempt(context, command, context_ref, constraints,
                should_cancel, discovered_owner=owner) as (connection, live, top, args, reserved):
            scope = args[1:9]
            # Validate every returned binding before either dispatch or replay.
            replay = self._public_attempt(command, context_ref, reserved, scope)
            if reserved.get('dispatch') is not True:
                return replay
            _require_snapshot(reserved.get('state') == 'reserved')
            attempt_ref, acquisition_ref = _ref(reserved.get('attempt_ref')), _ref(reserved.get('acquisition_ref'))
            remaining = reserved.get('remaining_seconds')
            if type(remaining) not in (int, float) or not math.isfinite(remaining) or not 0 < remaining <= 120:
                raise AlbumTopError('provider_cancelled', 503)
            sql_now, lease_until = _timestamp(reserved.get('sql_now')), _timestamp(reserved.get('lease_until'))
            # Use the smaller representation to avoid ever extending SQL's
            # duration through JSON floating-point/microsecond conversion.
            remaining = math.nextafter(float(min(remaining, (lease_until - sql_now).total_seconds())), 0.0)
            deadline = math.nextafter(anchor + remaining, -math.inf)
            if remaining <= 0 or not math.isfinite(deadline) or deadline <= anchor:
                raise AlbumTopError('provider_cancelled', 503)
        # Context exit must acknowledge commit. Unknown commit leaves dispatch
        # unused; observing the old row later cannot claim it.
        cancellation_latched = False
        cancellation_failure = None
        last_monotonic = anchor
        def cancelled():
            nonlocal cancellation_latched, cancellation_failure, last_monotonic
            if cancellation_failure is not None:
                raise cancellation_failure
            if cancellation_latched:
                return True
            try:
                current = _monotonic(self.acquisition.monotonic_clock)
                if current < last_monotonic or current >= deadline:
                    cancellation_latched = True
                else:
                    last_monotonic = current
                    cancellation_latched = should_cancel is not None and bool(should_cancel())
            except BaseException as error:
                # The shared transport may catch an ordinary callback failure
                # and check again. A later valid sample must never restore this
                # invocation's dispatch/storage lifetime or change its error.
                cancellation_latched = True
                cancellation_failure = error
                raise
            return cancellation_latched
        _cancel(cancelled)
        failure = None
        try:
            facts = validate_release_group_evidence(self.acquisition.provider(command.release_group_id,
                user_agent=self.acquisition.user_agent, should_cancel=cancelled))
            if facts.release_group_id != command.release_group_id:
                raise RemoteAlbumEvidenceError('provider_identity_changed')
        except RemoteAlbumEvidenceError as error:
            if error.code == 'provider_cancelled':
                raise AlbumTopError('provider_cancelled', 503) from None
            failure = error.code if error.code in _FAILURE_CODES else 'provider_unavailable'
        _cancel(cancelled)
        with self.acquisition._authorized(context, command.destination, constraints, cancelled,
                write=True, discovered_owner=owner, budget_lock=True) as (connection, live, top):
            args = (*self._attempt_args(live, top, command, context_ref), attempt_ref, acquisition_ref)
            if failure is None:
                value = _sql(connection, 'finish_top_remote_attempt', (*args, facts.digest,
                    facts.title, facts.artist_display, facts.first_release_date, facts.primary_type))
            else:
                value = _sql(connection, 'fail_top_remote_attempt', (*args, failure))
            return self._public_attempt(command, context_ref, value, args[1:9])
