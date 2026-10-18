"""Dormant, bounded process-local evidence ownership; no authority or persistence.

Explicit construction only. No queues, tasks, source opens, path fallback or
receipt synthesis. Trusted future callers own authorization and commit fencing.
"""
from dataclasses import dataclass
import math
import threading
import uuid

from music_app.services.retained_playback_source import (
    SharedPlaybackSourceOwner, SourceUnavailable,
)


@dataclass(frozen=True)
class SourceBinding:
    process_epoch: str
    account_id: str
    library_id: str
    authenticated_session_id: str
    device_id: str
    logical_session_id: str
    track_id: str
    file_id: str
    root_id: str
    sample_rate: int

    def __post_init__(self):
        for name in self.__dataclass_fields__:
            value = getattr(self, name)
            if name == 'sample_rate':
                if type(value) is not int or not 1 <= value <= 768000:
                    raise ValueError('invalid_sample_rate')
            elif type(value) is not str or not value or len(value.encode('utf-8')) > 256:
                raise ValueError('invalid_binding')


class _Reservation:
    def __init__(self, registry, account_id):
        self.registry, self.account_id = registry, account_id
        self.entry = None


class _Lease:
    def __init__(self, reservation, owner, binding, decoder_uuid, now):
        self.reservation, self._owner, self.binding = reservation, owner, binding
        self.decoder_uuid, self.evidence = decoder_uuid, None
        self.generation = 0
        self.delivery_open = self.collection_open = True
        self.opened_at, self.hard_deadline = now, now + 7200.0
        self.idle_deadline, self.last_keepalive = now + 300.0, now - 60.0
        self.final_deadline = None
        self.terminal = None
        self.snapshot = None
        self.reason = None
        self.operations = 0
        self.observation_active = False


class EvidenceOperationPin:
    def __init__(self, registry, lease, work_kind):
        self._registry, self._lease, self._kind = registry, lease, work_kind
        self._generation = lease.generation
        self._source_pin = None
        self._gate = threading.Lock()
        self._released = False
        self._checked = False

    @property
    def binding(self):
        return self._lease.binding

    @property
    def decoder_uuid(self):
        return self._lease.decoder_uuid

    def check(self):
        with self._gate:
            self._registry._validate(self, require_checked=False)
            self._checked = False
            try:
                observation = self._source_pin.check()
            except BaseException:
                self._registry.abandon(self._lease, 'source_check_failed')
                raise
            self._registry._validate(self, require_checked=False)
            self._checked = True
            return observation

    def release(self):
        # A timed-out caller cannot free this slot while check still runs.
        with self._gate:
            if self._released:
                return
            self._source_pin.release()
            registry = self._registry
            with registry._state:
                registry._pins.remove(self)
                self._released = True
                self._lease.operations -= 1
                registry._running[self._kind] -= 1
                if self._kind == 'observation':
                    self._lease.observation_active = False
        registry.reap_cleanup()


class EvidenceSourceLeaseRegistry:
    def __init__(self, process_epoch, monotonic_clock):
        if type(process_epoch) is not str or not process_epoch or len(process_epoch) > 256:
            raise ValueError('invalid_process_epoch')
        if not callable(monotonic_clock):
            raise ValueError('clock_required')
        self.process_epoch, self._clock = process_epoch, monotonic_clock
        self._state = threading.Lock()
        self._slots = set()
        self._by_uuid = {}
        self._running = {'checkpoint': 0, 'observation': 0}
        self._pins = set()
        self._shutdown = False
        self._last_now = None

    def _now(self):
        # Injected code is never called under a registry/owner state mutex.
        now = self._clock()
        if type(now) not in (int, float) or not math.isfinite(now):
            raise ValueError('invalid_monotonic_clock')
        with self._state:
            # Clamp out-of-order thread samples; never renew using older time.
            self._last_now = now if self._last_now is None else max(now, self._last_now)
            return self._last_now

    def reserve(self, account_id):
        if type(account_id) is not str or not account_id or len(account_id.encode('utf-8')) > 256:
            raise ValueError('invalid_account')
        reservation = _Reservation(self, account_id)
        with self._state:
            if (self._shutdown or len(self._slots) >= 128
                    or sum(slot.account_id == account_id for slot in self._slots) >= 32):
                raise SourceUnavailable('evidence_capacity_limited')
            self._slots.add(reservation)
        return reservation

    def cancel_reservation(self, reservation):
        with self._state:
            if reservation not in self._slots or reservation.registry is not self:
                raise SourceUnavailable('reservation_unavailable')
            if reservation.entry is not None:
                raise SourceUnavailable('reservation_already_attached')
            self._slots.remove(reservation)

    def attach(self, reservation, owner, playback_token, trusted_binding):
        if type(trusted_binding) is not SourceBinding:
            raise ValueError('exact_binding_required')
        if type(owner) is not SharedPlaybackSourceOwner:
            raise ValueError('shared_owner_required')
        now = self._now()
        lease = _Lease(reservation, owner, trusted_binding, str(uuid.uuid4()), now)
        try:
            with self._state:
                if (self._shutdown or reservation not in self._slots
                        or reservation.registry is not self or reservation.entry is not None
                        or trusted_binding.process_epoch != self.process_epoch
                        or trusted_binding.account_id != reservation.account_id
                        or lease.decoder_uuid in self._by_uuid):
                    raise SourceUnavailable('reservation_unavailable')
                # Root owner before transfer; insertion failure remains charged.
                reservation.entry = lease
                try:
                    lease.evidence = owner.attach_evidence(playback_token)
                except BaseException:
                    reservation.entry = None
                    raise
                self._by_uuid[lease.decoder_uuid] = lease
        except BaseException:
            if lease.evidence is not None:
                self.abandon(lease, 'attachment_failed')
            raise
        return lease

    def _owns_locked(self, lease):
        return (type(lease) is _Lease and lease.reservation in self._slots
                and lease.reservation.entry is lease)

    def _revoke_locked(self, lease, reason):
        if lease.delivery_open:
            lease.delivery_open = lease.collection_open = False
            lease.generation += 1
            lease.reason = reason
            lease._owner.release_evidence(lease.evidence)

    def _eligible_locked(self, lease, now):
        now = max(now, self._last_now)
        if not self._owns_locked(lease):
            raise SourceUnavailable('source_unavailable')
        deadline = min(lease.idle_deadline, lease.hard_deadline,
                       lease.final_deadline if lease.final_deadline is not None else math.inf)
        if lease.delivery_open and now >= deadline:
            self._revoke_locked(lease, 'expired')
        if not lease.delivery_open:
            raise SourceUnavailable('evidence_unavailable')

    def lookup_and_pin(self, epoch, decoder_uuid, exact_authenticated_binding, work_kind):
        if (type(epoch) is not str or type(decoder_uuid) is not str
                or len(decoder_uuid) > 64 or type(work_kind) is not str):
            raise SourceUnavailable('source_unavailable')
        now = self._now()
        with self._state:
            lease = self._by_uuid.get(decoder_uuid)
            if (epoch != self.process_epoch or lease is None
                    or type(exact_authenticated_binding) is not SourceBinding
                    or exact_authenticated_binding != lease.binding):
                raise SourceUnavailable('source_unavailable')
            self._eligible_locked(lease, now)
            if (work_kind not in self._running or self._running[work_kind] >= 2
                    or work_kind == 'observation' and lease.observation_active):
                raise SourceUnavailable('operation_capacity_limited')
            pin = EvidenceOperationPin(self, lease, work_kind)
            self._pins.add(pin)
            try:
                pin._source_pin = lease._owner.pin_evidence(lease.evidence)
            except BaseException:
                self._pins.remove(pin)
                raise
            lease.operations += 1
            self._running[work_kind] += 1
            if work_kind == 'observation':
                lease.observation_active = True
            return pin

    def _validate_locked(self, pin, now, require_checked=True):
        if (type(pin) is not EvidenceOperationPin or pin._registry is not self
                or pin not in self._pins or pin._released or require_checked and not pin._checked):
            raise SourceUnavailable('evidence_pin_invalid')
        self._eligible_locked(pin._lease, now)
        if pin._generation != pin._lease.generation:
            raise SourceUnavailable('evidence_generation_changed')
        return pin._lease

    def _validate(self, pin, require_checked=True):
        now = self._now()
        with self._state:
            return self._validate_locked(pin, now, require_checked)

    def validate(self, pin):
        with pin._gate:
            lease = self._validate(pin)
            return lease.binding

    def record_authorized_activity(self, pin, *, keepalive=False):
        with pin._gate:
            now = self._now()
            with self._state:
                lease = self._validate_locked(pin, now)
                if keepalive and now - lease.last_keepalive < 60.0:
                    return False
                if keepalive:
                    lease.last_keepalive = now
                if lease.final_deadline is None:
                    lease.idle_deadline = min(now + 300.0, lease.hard_deadline)
                return True

    def close_collection(self, handle, reason):
        if type(reason) is not str or len(reason) > 128:
            raise ValueError('invalid_reason')
        now = self._now()
        with self._state:
            self._eligible_locked(handle, now)
            handle.collection_open = False

    def mark_first_admission_committed(self, pin, canonical_snapshot):
        # Caller supplies canonical immutable catalog bytes only after commit.
        if type(canonical_snapshot) is not bytes or len(canonical_snapshot) > 4096:
            raise ValueError('snapshot_capacity')
        with pin._gate:
            now = self._now()
            with self._state:
                lease = self._validate_locked(pin, now)
                if lease.snapshot is not None and lease.snapshot != canonical_snapshot:
                    raise SourceUnavailable('snapshot_already_fixed')
                lease.snapshot = canonical_snapshot

    def mark_terminal_committed(self, pin, sequence, digest, committed_at, receipt_reference):
        terminal = self._terminal_identity(sequence, digest, receipt_reference)
        if type(committed_at) not in (int, float) or not math.isfinite(committed_at):
            raise ValueError('invalid_commit_time')
        with pin._gate:
            now = self._now()
            with self._state:
                lease = self._validate_locked(pin, now)
                if not lease.opened_at <= committed_at <= now:
                    raise ValueError('invalid_commit_time')
                if lease.terminal is not None:
                    if lease.terminal != (terminal, committed_at):
                        raise SourceUnavailable('terminal_conflict')
                    return
                lease.terminal = (terminal, committed_at)
                lease.collection_open = False
                lease.final_deadline = min(committed_at + 300.0, lease.idle_deadline, lease.hard_deadline)
                if max(now, self._last_now) >= lease.final_deadline:
                    self._revoke_locked(lease, 'expired')
        # A delayed committed fact may already have exhausted its fixed grace.
        # Reconcile delivery immediately; physical disposal remains outside R.
        self.reap_cleanup()

    @staticmethod
    def _terminal_identity(sequence, digest, receipt_reference):
        if type(sequence) is not int or not 0 <= sequence < 2**63:
            raise ValueError('invalid_terminal_sequence')
        if (type(digest) is not str or len(digest) != 64
                or any(c not in '0123456789abcdef' for c in digest)
                or type(receipt_reference) is not str or not receipt_reference
                or len(receipt_reference.encode('utf-8')) > 256):
            raise ValueError('invalid_terminal_identity')
        return (sequence, digest, receipt_reference)

    def ack_terminal(self, pin, sequence, digest, trusted_committed_receipt):
        """Requires an exact-scope, physically checked live pin; no premature ack."""
        if type(pin) is not EvidenceOperationPin:
            raise SourceUnavailable('evidence_pin_invalid')
        terminal = self._terminal_identity(sequence, digest, trusted_committed_receipt)
        with pin._gate:
            now = self._now()
            with self._state:
                lease = pin._lease
                if (pin._registry is not self or pin not in self._pins
                        or pin._released or pin._checked is not True):
                    raise SourceUnavailable('evidence_pin_invalid')
                # Only duplicate acknowledgement of this still-accounted pin.
                if (pin._registry is self and self._owns_locked(lease)
                        and lease.reason == 'terminal_ack' and lease.terminal is not None
                        and lease.terminal[0] == terminal):
                    return
                lease = self._validate_locked(pin, now)
                if lease.terminal is None or lease.terminal[0] != terminal:
                    raise SourceUnavailable('terminal_not_committed')
                self._revoke_locked(lease, 'terminal_ack')
        self.reap_cleanup()

    def abandon(self, handle, reason):
        if type(reason) is not str or not reason or len(reason) > 128:
            raise ValueError('invalid_reason')
        with self._state:
            if not self._owns_locked(handle):
                raise SourceUnavailable('source_unavailable')
            self._revoke_locked(handle, reason)
        self.reap_cleanup()

    def expire(self):
        now = self._now()
        with self._state:
            for slot in self._slots:
                if slot.entry is not None:
                    try:
                        self._eligible_locked(slot.entry, now)
                    except SourceUnavailable:
                        pass
        self.reap_cleanup()

    def shutdown(self):
        with self._state:
            self._shutdown = True
            empty = tuple(slot for slot in self._slots if slot.entry is None)
            for slot in empty:
                self._slots.remove(slot)
            for slot in self._slots:
                self._revoke_locked(slot.entry, 'shutdown')
        self.reap_cleanup()

    def reap_cleanup(self):
        with self._state:
            candidates = tuple(slot.entry for slot in self._slots
                               if slot.entry is not None and not slot.entry.delivery_open
                               and not slot.entry.operations)
        for lease in candidates:
            # Close can block or fail; original capacity remains accountable.
            status = lease._owner.try_close()
            if status == 'disposed':
                with self._state:
                    if (self._owns_locked(lease) and not lease.delivery_open
                            and not lease.operations):
                        if self._by_uuid.get(lease.decoder_uuid) is lease:
                            del self._by_uuid[lease.decoder_uuid]
                        self._slots.remove(lease.reservation)
