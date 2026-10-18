"""Registry cases over actual rooted/retained/shared ownership; never fake admission."""
from dataclasses import replace
from unittest.mock import patch

from retained_owner_memory import Barrier, Case, ObservedLock, Task

DIGEST = 'a' * 64


class EvidenceLeaseTests(Case):
    def test_reservation_process_128_and_account_32_caps(self):
        reservations = []
        for account in range(4):
            reservations.extend(self.registry.reserve(str(account)) for _ in range(32))
            with self.unavailable('evidence_capacity_limited'):
                self.registry.reserve(str(account))
        self.assertEqual(len(self.registry._slots), 128)
        with self.unavailable('evidence_capacity_limited'):
            self.registry.reserve('fifth')
        self.registry.cancel_reservation(reservations[0])
        new = self.registry.reserve('fifth')
        self.assertEqual(len(self.registry._slots), 128)
        self.registry.shutdown()
        self.assertEqual(len(self.registry._slots), 0)
        with self.unavailable('evidence_capacity_limited'):
            self.registry.reserve('fifth')

    def test_128_expired_live_playbacks_remain_charged(self):
        values = [self.attached(str(i // 32), str(i)) for i in range(128)]
        self.clock.value = 300
        self.registry.expire()
        self.assertEqual(len(self.registry._slots), 128)
        self.assertEqual(len(self.registry._by_uuid), 128)
        with self.unavailable('evidence_capacity_limited'):
            self.registry.reserve('fifth')
        for value in values:
            self.assertFalse(value.lease.delivery_open)
            self.assertTrue(value.playback.live)
            self.assertEqual(value.resource.closes, 0)
            self.playback_check(value)
            value.owner.release_playback(value.playback)
        self.registry.reap_cleanup()
        self.assertEqual(len(self.registry._slots), 0)
        self.assertEqual(len(self.registry._by_uuid), 0)
        self.assertTrue(all(v.resource.closes == 1 for v in values))

    def test_wrong_binding_epoch_uuid_never_touch_resource(self):
        value = self.attached()
        count = value.resource.checks
        for epoch, uuid, binding in (
            ('old', value.lease.decoder_uuid, value.binding),
            ('epoch', 'unknown', value.binding),
            ('epoch', value.lease.decoder_uuid, replace(value.binding, library_id='other')),
        ):
            with self.unavailable('source_unavailable'):
                self.registry.lookup_and_pin(epoch, uuid, binding, 'checkpoint')
        self.assertEqual(value.resource.checks, count)
        self.assertEqual(value.resource.reader_opens, 0)
        self.retire(value)

    def test_attach_foreign_token_rolls_back_without_e_transfer(self):
        value = self.source()
        reservation = self.registry.reserve('account')
        with self.unavailable('playback_token_required'):
            self.registry.attach(reservation, value.owner, object(), self.binding())
        self.assertIsNone(reservation.entry)
        self.assertIsNone(value.owner._e)
        self.assertEqual(len(self.registry._slots), 1)
        self.playback_check(value)
        self.registry.cancel_reservation(reservation)
        value.owner.release_playback(value.playback)

    def test_attach_map_allocation_failure_retains_original_slot(self):
        class FailingMap(dict):
            def __setitem__(self, key, value):
                raise MemoryError('controlled publication allocation')
        self.registry._by_uuid = FailingMap()
        value = self.source()
        reservation = self.registry.reserve('account')
        with self.assertRaises(MemoryError):
            self.registry.attach(reservation, value.owner, value.playback, self.binding())
        lease = reservation.entry
        self.assertIsNotNone(lease)
        self.assertFalse(lease.evidence.live)
        self.assertEqual(lease.reason, 'attachment_failed')
        self.assertEqual(len(self.registry._slots), 1)
        self.assertEqual(value.resource.closes, 0)
        self.playback_check(value)
        with self.unavailable('reservation_already_attached'):
            self.registry.cancel_reservation(reservation)
        value.owner.release_playback(value.playback)
        self.registry.reap_cleanup()
        self.assertEqual(len(self.registry._slots), 0)
        self.assertEqual(value.resource.closes, 1)

    def test_fixed_kind_slots_and_one_observation_per_lease(self):
        values = [self.attached(track=str(i)) for i in range(3)]
        cp = [self.pin(values[i]) for i in range(2)]
        op = [self.pin(values[i], 'observation') for i in range(2)]
        self.assertEqual(self.registry._running, {'checkpoint': 2, 'observation': 2})
        for kind in ('checkpoint', 'observation'):
            with self.unavailable('operation_capacity_limited'):
                self.pin(values[2], kind)
        op[1].release()
        with self.unavailable('operation_capacity_limited'):
            self.pin(values[0], 'observation')
        replacement = self.pin(values[2], 'observation')
        for pin in cp + op + [replacement]:
            pin.release()
        self.assertEqual(self.registry._running, {'checkpoint': 0, 'observation': 0})
        for value in values:
            self.retire(value)

    def test_failed_owner_pin_does_not_leak_registry_slot(self):
        value = self.attached()
        pins = [self.pin(value), self.pin(value, 'observation')]
        with self.unavailable('source_pin_capacity'):
            self.pin(value)
        self.assertEqual(value.lease.operations, 2)
        self.assertEqual(len(self.registry._pins), 2)
        self.assertEqual(self.registry._running, {'checkpoint': 1, 'observation': 1})
        for pin in pins:
            pin.release()
        self.retire(value)

    def test_expiry_progresses_during_check_release_waits_for_actual_return(self):
        value, other, third = [self.attached(track=str(i)) for i in range(3)]
        pin, second = self.pin(value), self.pin(other)
        pin._gate = ObservedLock()
        barrier = Barrier()
        value.resource.check_barrier = barrier
        checker = Task(pin.check)
        releaser = None
        try:
            barrier.reached()
            for lock in (self.registry._state, value.owner._state):
                self.assertTrue(lock.acquire(blocking=False))
                lock.release()
            # Explicit abandonment models a timed-out delivery, not completion.
            self.registry.abandon(value.lease, 'observation_timeout')
            releaser = Task(pin.release)
            self.assertTrue(pin._gate.contender.wait(10))
            self.assertFalse(releaser.done.is_set())
            self.assertEqual(self.registry._running['checkpoint'], 2)
            self.assertEqual(value.owner._pins['evidence'], 1)
            with self.unavailable('operation_capacity_limited'):
                self.pin(third)
            self.assertEqual(value.resource.closes, 0)
            self.assertFalse(value.source._failed)
        finally:
            barrier.resume.set()
            checker.finish()
            if releaser:
                releaser.finish()
        self.assertIsInstance(checker.error, self.m.retained.SourceUnavailable)
        self.assertIsNone(releaser.error)
        self.assertFalse(value.source._failed)
        self.assertFalse(value.rooted._failed)
        self.assertEqual(self.registry._running['checkpoint'], 1)
        pin.release()
        replacement = self.pin(third)
        replacement.release()
        second.release()
        value.resource.check_barrier = None
        self.playback_check(value)
        for item in (value, other, third):
            self.retire(item)

    def test_inclusive_expiry_during_check_rejects_late_result(self):
        value = self.attached()
        pin = self.pin(value)
        barrier = Barrier()
        value.resource.check_barrier = barrier
        task = Task(pin.check)
        try:
            barrier.reached()
            self.clock.value = 300
            self.registry.expire()
            self.assertFalse(value.lease.evidence.live)
            self.assertEqual(value.lease.reason, 'expired')
            self.assertEqual(len(self.registry._pins), 1)
            self.assertEqual(value.resource.closes, 0)
        finally:
            barrier.resume.set()
            task.finish()
        self.assertIsInstance(task.error, self.m.retained.SourceUnavailable)
        self.assertFalse(pin._checked)
        self.assertFalse(value.source._failed)
        value.resource.check_barrier = None
        pin.release()
        self.playback_check(value)
        self.retire(value)

    def test_keepalive_rate_limit_idle_hard_and_collection_do_not_extend(self):
        value = self.attached()
        pin = self.pin(value, checked=True)
        self.assertTrue(self.registry.record_authorized_activity(pin, keepalive=True))
        self.clock.value = 59
        self.assertFalse(self.registry.record_authorized_activity(pin, keepalive=True))
        self.assertEqual(value.lease.idle_deadline, 300)
        self.clock.value = 60
        self.assertTrue(self.registry.record_authorized_activity(pin, keepalive=True))
        self.assertEqual(value.lease.idle_deadline, 360)
        self.clock.value = 100
        pin.check()
        self.registry.close_collection(value.lease, 'budget')
        self.assertEqual(value.lease.idle_deadline, 360)
        self.assertEqual(value.lease.generation, 0)
        self.assertTrue(value.lease.evidence.live)
        # Advance by legal checked activity, never by directly changing deadlines.
        for now in range(300, 7200, 200):
            self.clock.value = now
            pin.check()
            self.registry.record_authorized_activity(pin)
        self.assertEqual(value.lease.idle_deadline, 7200)
        self.clock.value = 7200
        self.registry.expire()
        with self.unavailable('evidence_unavailable'):
            pin.check()
        self.assertEqual(value.lease.reason, 'expired')
        pin.release()
        self.playback_check(value)
        self.retire(value)

    def test_unchecked_activity_and_snapshot_do_not_publish(self):
        value = self.attached()
        pin = self.pin(value)
        with self.unavailable('evidence_pin_invalid'):
            self.registry.record_authorized_activity(pin)
        with self.unavailable('evidence_pin_invalid'):
            self.registry.mark_first_admission_committed(pin, b'catalog')
        self.assertIsNone(value.lease.snapshot)
        self.assertEqual(value.lease.idle_deadline, 300)
        pin.check()
        with self.assertRaisesRegex(ValueError, 'snapshot_capacity'):
            self.registry.mark_first_admission_committed(pin, b'x' * 4097)
        self.registry.mark_first_admission_committed(pin, b'x' * 4096)
        self.registry.mark_first_admission_committed(pin, b'x' * 4096)
        with self.unavailable('snapshot_already_fixed'):
            self.registry.mark_first_admission_committed(pin, b'changed')
        self.assertEqual(value.lease.snapshot, b'x' * 4096)
        pin.release()
        self.retire(value)

    def test_terminal_sequence_snapshot_replay_frozen_grace_and_ack(self):
        value = self.attached()
        pin = self.pin(value, checked=True)
        with self.unavailable('terminal_not_committed'):
            self.registry.ack_terminal(pin, 2, DIGEST, 'receipt-2')
        self.registry.mark_first_admission_committed(pin, b'{"catalog":"frozen"}')
        self.clock.value = 100
        self.registry.record_authorized_activity(pin)
        self.registry.close_collection(value.lease, 'n_pending_collection_cap')
        self.assertTrue(value.lease.delivery_open)
        self.assertEqual(value.lease.generation, 0)
        self.registry.mark_terminal_committed(pin, 2, DIGEST, 100, 'receipt-2')
        self.assertEqual(value.lease.final_deadline, 400)
        self.clock.value = 200
        self.registry.record_authorized_activity(pin)
        self.registry.mark_terminal_committed(pin, 2, DIGEST, 100, 'receipt-2')
        self.assertEqual(value.lease.final_deadline, 400)
        self.assertEqual(value.lease.idle_deadline, 400)
        self.assertEqual(value.lease.snapshot, b'{"catalog":"frozen"}')
        with self.unavailable('terminal_conflict'):
            self.registry.mark_terminal_committed(pin, 3, DIGEST, 100, 'receipt-3')
        with self.unavailable('terminal_not_committed'):
            self.registry.ack_terminal(pin, 2, 'b' * 64, 'receipt-2')
        self.assertTrue(value.lease.delivery_open)
        self.registry.ack_terminal(pin, 2, DIGEST, 'receipt-2')
        generation = value.lease.generation
        self.registry.ack_terminal(pin, 2, DIGEST, 'receipt-2')
        self.assertEqual(value.lease.generation, generation)
        self.assertEqual(value.resource.closes, 0)
        self.playback_check(value)
        pin.release()
        self.retire(value)

    def test_b3_forged_released_and_second_real_unchecked_ack_rejected(self):
        value = self.attached()
        checked = self.pin(value, checked=True)
        unchecked = self.pin(value)
        self.registry.mark_terminal_committed(checked, 1, DIGEST, 0, 'receipt')
        self.registry.ack_terminal(checked, 1, DIGEST, 'receipt')
        forged = self.m.leases.EvidenceOperationPin(self.registry, value.lease, 'checkpoint')
        forged._checked = True  # Constructor-forged even when check flag mimics success.
        for bad in (object(), forged, unchecked):
            with self.unavailable('evidence_pin_invalid'):
                self.registry.ack_terminal(bad, 1, DIGEST, 'receipt')
        self.registry.ack_terminal(checked, 1, DIGEST, 'receipt')
        checked.release()
        with self.unavailable('evidence_pin_invalid'):
            self.registry.ack_terminal(checked, 1, DIGEST, 'receipt')
        self.assertEqual(value.lease.generation, 1)
        self.assertEqual(self.registry._running['checkpoint'], 1)
        unchecked.release()
        self.retire(value)

    def test_b2_delayed_terminal_equal_and_later_immediately_revoke_e(self):
        for callback in (400, 401):
            with self.subTest(callback=callback):
                self.clock.value = 0
                registry = self.m.leases.EvidenceSourceLeaseRegistry('epoch', self.clock)
                self.registry = registry
                value = self.attached()
                pin = self.pin(value, checked=True)
                self.clock.value = 250
                registry.record_authorized_activity(pin)
                self.assertEqual(value.lease.idle_deadline, 550)
                self.clock.value = callback
                registry.mark_terminal_committed(pin, 1, DIGEST, 100, 'receipt')
                self.assertEqual(value.lease.terminal, ((1, DIGEST, 'receipt'), 100))
                self.assertEqual(value.lease.final_deadline, 400)
                self.assertFalse(value.lease.delivery_open)
                self.assertFalse(value.lease.evidence.live)
                self.assertEqual(value.lease.reason, 'expired')
                self.assertEqual(value.resource.closes, 0)
                self.assertFalse(value.source._failed)
                pin.release()
                self.playback_check(value)
                self.retire(value)

    def test_delayed_clock_sample_cannot_restore_grace(self):
        value = self.attached()
        pin = self.pin(value, checked=True)
        self.clock.value = 250
        self.registry.record_authorized_activity(pin)
        barrier = Barrier()
        self.clock.value = 399
        self.clock.hook = barrier.block
        task = Task(lambda: self.registry.mark_terminal_committed(pin, 1, DIGEST, 100, 'receipt'))
        try:
            barrier.reached()
            self.clock.value = 400
            self.registry.expire()  # Old idle 550 remains eligible; global time advances.
            self.assertTrue(value.lease.delivery_open)
        finally:
            barrier.resume.set()
            task.finish()
        self.assertIsNone(task.error)
        self.assertEqual(value.lease.final_deadline, 400)
        self.assertFalse(value.lease.delivery_open)
        pin.release()
        self.retire(value)

    def test_terminal_grace_earlier_idle_and_hard_boundaries(self):
        for hard in (False, True):
            with self.subTest(hard=hard):
                self.clock.value = 0
                self.registry = self.m.leases.EvidenceSourceLeaseRegistry('epoch', self.clock)
                value = self.attached()
                pin = self.pin(value, checked=True)
                if hard:
                    for now in range(200, 7001, 200):
                        self.clock.value = now
                        self.registry.record_authorized_activity(pin)
                    self.clock.value = 7100
                    self.registry.record_authorized_activity(pin)
                    commit, boundary = 7100, 7200
                else:
                    self.clock.value = 100
                    commit, boundary = 100, 300
                self.registry.mark_terminal_committed(pin, 1, DIGEST, commit, 'receipt')
                self.assertEqual(value.lease.final_deadline, boundary)
                self.clock.value = boundary
                self.registry.expire()
                with self.unavailable('evidence_unavailable'):
                    self.registry.ack_terminal(pin, 1, DIGEST, 'receipt')
                self.assertEqual(value.lease.reason, 'expired')
                pin.release()
                self.retire(value)

    def test_shutdown_keeps_playback_child_and_pins_charged(self):
        value = self.attached()
        pin = self.pin(value, checked=True)
        child = value.owner.begin_child(value.playback)
        child.mark_launched()
        self.registry.reserve('empty')
        self.registry.shutdown()
        self.assertEqual(len(self.registry._slots), 1)
        self.assertEqual(value.lease.reason, 'shutdown')
        self.assertEqual(value.rooted._active, 1)
        self.assertEqual(value.resource.closes, 0)
        self.assertTrue(value.playback.live)
        self.playback_check(value)
        pin.release()
        with self.unavailable('playback_responsibility_pending'):
            value.owner.release_playback(value.playback)
        child.release_after_reap(wait_result=0, cleanup_complete=True)
        value.owner.release_playback(value.playback)
        self.registry.reap_cleanup()
        self.assertEqual(len(self.registry._slots), 0)
        self.assertEqual(value.resource.closes, 1)

    def test_cleanup_failure_or_incomplete_result_quarantines_original_capacity(self):
        for failure in ('raises', 'incomplete'):
            with self.subTest(failure=failure):
                self.registry = self.m.leases.EvidenceSourceLeaseRegistry('epoch', self.clock)
                value = self.attached()
                if failure == 'raises':
                    value.resource.fail_close = True
                else:
                    value.resource.cleanup_complete = False
                self.retire(value)
                for _ in range(3):
                    self.registry.reap_cleanup()
                self.assertEqual(value.owner.try_close(), 'cleanup_failed')
                self.assertEqual(value.resource.closes, 1)
                self.assertEqual(len(self.registry._slots), 1)
                self.assertIs(self.registry._by_uuid[value.lease.decoder_uuid], value.lease)
                self.assertFalse(value.rooted.drained.is_set())
                for _ in range(31):
                    self.registry.reserve('account')
                with self.unavailable('evidence_capacity_limited'):
                    self.registry.reserve('account')
                self.registry.shutdown()
                self.assertEqual(len(self.registry._slots), 1)
                self.assertEqual(value.resource.closes, 1)

    def test_binding_snapshot_and_terminal_bounds_fail_without_e_loss(self):
        for changes in ({'account_id': ''}, {'sample_rate': True},
                        {'device_id': 'x' * 257}, {'sample_rate': 768001}):
            with self.assertRaises(ValueError):
                replace(self.binding(), **changes)
        value = self.attached()
        pin = self.pin(value, checked=True)
        for sequence, digest, receipt in ((True, DIGEST, 'r'), (-1, DIGEST, 'r'),
                                         (2**63, DIGEST, 'r'), (1, 'A' * 64, 'r'),
                                         (1, DIGEST, ''), (1, DIGEST, 'r' * 257)):
            with self.assertRaises(ValueError):
                self.registry.mark_terminal_committed(pin, sequence, digest, 0, receipt)
        for committed in (-1, 1, float('nan'), True):
            with self.assertRaises(ValueError):
                self.registry.mark_terminal_committed(pin, 1, DIGEST, committed, 'r')
        self.assertIsNone(value.lease.terminal)
        self.assertTrue(value.lease.evidence.live)
        self.assertFalse(value.source._failed)
        pin.release()
        self.retire(value)

    def test_second_checked_real_pin_duplicate_ack_is_harmless(self):
        value = self.attached()
        first, second = self.pin(value, checked=True), self.pin(value, checked=True)
        self.registry.mark_terminal_committed(first, 1, DIGEST, 0, 'receipt')
        self.registry.ack_terminal(first, 1, DIGEST, 'receipt')
        self.registry.ack_terminal(second, 1, DIGEST, 'receipt')
        self.assertEqual(value.lease.generation, 1)
        first.release()
        second.release()
        self.retire(value)

    def test_b2_cleanup_callback_runs_outside_registry_mutex(self):
        value = self.attached()
        pin = self.pin(value, checked=True)
        self.clock.value = 250
        self.registry.record_authorized_activity(pin)
        self.clock.value = 400
        observations = []
        # Active operation excludes the lease from cleanup candidates. Inspect
        # the sweep entry itself instead to prove the delayed callback unlocked.
        original_reap = self.registry.reap_cleanup
        def reap():
            available = self.registry._state.acquire(blocking=False)
            observations.append(available)
            if available:
                self.registry._state.release()
            original_reap()
        with patch.object(self.registry, 'reap_cleanup', reap):
            self.registry.mark_terminal_committed(pin, 1, DIGEST, 100, 'r')
        self.assertEqual(observations, [True])
        pin.release()
        self.retire(value)
