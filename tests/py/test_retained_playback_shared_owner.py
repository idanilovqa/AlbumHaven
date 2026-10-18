"""Dormant exact-owner unit cases. Source authored only; execution unapproved."""
import ast
from pathlib import Path
import threading
from unittest.mock import patch

from retained_owner_memory import Barrier, Case, Task


class SharedOwnerTests(Case):
    def test_b1_transfer_tuple_precedes_irrevocable_claim(self):
        path = Path(__file__).resolve().parents[2] / 'music_app/services/retained_playback_source.py'
        tree = ast.parse(path.read_text())
        owner = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'SharedPlaybackSourceOwner')
        create = next(n for n in owner.body if isinstance(n, ast.FunctionDef) and n.name == 'create')
        allocations = [n for n in ast.walk(create) if isinstance(n, ast.Assign)
                       and isinstance(n.value, ast.Tuple)
                       and any(isinstance(t, ast.Name) and t.id == 'result' for t in n.targets)]
        claims = [n for n in ast.walk(create) if isinstance(n, ast.Assign)
                  and any(isinstance(t, ast.Attribute) and t.attr == '_shared_owner_claimed' for t in n.targets)]
        self.assertEqual(len(allocations), 1)
        self.assertEqual(len(claims), 1)
        self.assertLess(allocations[0].lineno, claims[0].lineno)
        self.assertIsInstance(create.body[-1], ast.Return)
        self.assertEqual(ast.dump(create.body[-1].value), "Name(id='result', ctx=Load())")

    def test_exact_types_and_one_claim(self):
        value = self.source()
        with self.unavailable('source_ownership_unavailable'):
            self.m.retained.SharedPlaybackSourceOwner.create(value.source)
        with self.unavailable('retained_source_required'):
            self.m.retained.SharedPlaybackSourceOwner.create(object())
        with self.unavailable('playback_token_required'):
            value.owner.attach_evidence(object())
        value.owner.release_playback(value.playback)
        self.assertEqual(value.resource.closes, 1)

    def test_simultaneous_claim_has_one_winner(self):
        from retained_owner_memory import MemoryResource
        resource = MemoryResource(self.m)
        rooted = self.m.rooted.RootedRegularFile(resource)
        source = self.m.retained.RetainedPlaybackSource.from_rooted_lease(rooted, original_suffix='.flac')
        barrier = threading.Barrier(3)
        def claim():
            barrier.wait(10)
            return self.m.retained.SharedPlaybackSourceOwner.create(source)
        tasks = [Task(claim), Task(claim)]
        barrier.wait(10)
        for task in tasks:
            task.finish()
        winners = [task.result for task in tasks if task.error is None]
        losers = [task.error for task in tasks if task.error is not None]
        self.assertEqual(len(winners), 1)
        self.assertEqual(len(losers), 1)
        self.assertIsInstance(losers[0], self.m.retained.SourceUnavailable)
        owner, token = winners[0]
        owner.release_playback(token)
        self.assertEqual(resource.closes, 1)

    def test_p_first_e_first_and_e_never_reattaches(self):
        for first in ('p', 'e'):
            with self.subTest(first=first):
                value = self.source()
                owner, p = value.owner, value.playback
                e = owner.attach_evidence(p)
                if first == 'p':
                    owner.release_playback(p)
                    pin = owner.pin_evidence(e)
                    pin.check()
                    pin.release()
                    self.assertEqual(value.resource.closes, 0)
                    owner.release_evidence(e)
                else:
                    owner.release_evidence(e)
                    self.playback_check(value)
                    self.assertFalse(value.source._failed)
                    with self.unavailable('evidence_already_attached'):
                        owner.attach_evidence(p)
                    self.assertEqual(value.resource.closes, 0)
                    owner.release_playback(p)
                self.assertEqual(owner.try_close(), 'disposed')
                owner.release_playback(p)
                owner.release_evidence(e)
                owner.try_close()
                self.assertEqual(value.resource.closes, 1)
                self.assertTrue(value.rooted.drained.is_set())

    def test_pin_caps_four_playback_two_evidence(self):
        value = self.source()
        owner = value.owner
        e = owner.attach_evidence(value.playback)
        ps = [owner.pin_playback(value.playback) for _ in range(4)]
        es = [owner.pin_evidence(e) for _ in range(2)]
        with self.unavailable('source_pin_capacity'):
            owner.pin_playback(value.playback)
        with self.unavailable('source_pin_capacity'):
            owner.pin_evidence(e)
        with self.unavailable('playback_responsibility_pending'):
            owner.release_playback(value.playback)
        owner.release_evidence(e)
        for pin in ps:
            pin.check()
            pin.release()
        owner.release_playback(value.playback)
        self.assertEqual(value.resource.closes, 0)
        for pin in es:
            pin.release()
            pin.release()
        self.assertEqual(value.resource.closes, 1)
        self.assertEqual(owner._pins, {'playback': 0, 'evidence': 0})

    def test_child_reservation_precedes_exposure_and_p_release(self):
        value = self.source()
        barrier = Barrier()
        original = self.m.rooted.RootedRegularFile.reserve_child_use
        def reserve(rooted):
            barrier.block()
            return original(rooted)
        with patch.object(self.m.rooted.RootedRegularFile, 'reserve_child_use', reserve):
            task = Task(lambda: value.owner.begin_child(value.playback))
            try:
                barrier.reached()
                self.assertIsNotNone(value.owner._child)
                self.assertEqual(value.resource.reader_opens, 0)
                with self.unavailable('playback_responsibility_pending'):
                    value.owner.release_playback(value.playback)
                self.assertEqual(value.resource.closes, 0)
            finally:
                barrier.resume.set()
                task.finish()
        self.assertIsNone(task.error)
        child = task.result
        self.assertEqual(value.rooted._active, 1)
        child.release_no_child(proved_no_child=True, cleanup_complete=True)
        child.release_no_child(proved_no_child=True, cleanup_complete=True)
        self.assertEqual(value.rooted._active, 0)
        value.owner.release_playback(value.playback)
        self.assertEqual(value.resource.closes, 1)

    def test_child_reservation_allocation_failure_precedes_count(self):
        value = self.source()
        with patch.object(self.m.rooted, '_Reservation', side_effect=MemoryError('allocation')):
            with self.assertRaises(MemoryError):
                value.owner.begin_child(value.playback)
        self.assertIsNone(value.owner._child)
        self.assertEqual(value.rooted._active, 0)
        self.playback_check(value)
        value.owner.release_playback(value.playback)

    def test_child_uncertainty_requires_proof_then_reap_and_cleanup(self):
        value = self.source()
        child = value.owner.begin_child(value.playback)
        with self.unavailable('child_cleanup_unproven'):
            child.release_no_child(proved_no_child=False, cleanup_complete=True)
        with self.unavailable('child_reap_unproven'):
            child.release_after_reap(wait_result=None, cleanup_complete=True)
        self.assertEqual(value.rooted._active, 1)
        child.mark_launched()
        with self.unavailable('child_state_invalid'):
            child.release_no_child(proved_no_child=True, cleanup_complete=True)
        for wait, clean in ((True, True), (0, False), (None, True)):
            with self.unavailable('child_reap_unproven'):
                child.release_after_reap(wait_result=wait, cleanup_complete=clean)
        pin = value.owner.pin_playback(value.playback)
        reader = pin.reader()
        pin.release()
        reader.close()
        self.assertEqual(value.rooted._active, 1)
        with self.unavailable('playback_responsibility_pending'):
            value.owner.release_playback(value.playback)
        child.release_after_reap(wait_result=0, cleanup_complete=True)
        child.release_after_reap(wait_result=0, cleanup_complete=True)
        with self.unavailable('child_settlement_conflict'):
            child.release_after_reap(wait_result=1, cleanup_complete=True)
        value.owner.release_playback(value.playback)
        self.assertEqual(value.resource.closes, 1)

    def test_child_ticket_uncertain_close_is_not_retried(self):
        value = self.source()
        child = value.owner.begin_child(value.playback)
        ticket = child._rooted_ticket
        original = type(ticket).close
        count = []
        def uncertain(current):
            if current is ticket:
                count.append(1)
                raise OSError('uncertain ticket release')
            return original(current)
        with patch.object(type(ticket), 'close', uncertain):
            with self.assertRaises(OSError):
                child.release_no_child(proved_no_child=True, cleanup_complete=True)
            with self.unavailable('child_state_invalid'):
                child.release_no_child(proved_no_child=True, cleanup_complete=True)
        self.assertEqual(count, [1])
        self.assertIs(value.owner._child, child)
        self.assertEqual(value.rooted._active, 1)
        self.assertEqual(value.owner.try_close(), 'pending')
        self.assertEqual(value.resource.closes, 0)

    def test_reader_drain_owns_capacity_after_p_retirement(self):
        value = self.attached()
        pin = value.owner.pin_playback(value.playback)
        reader = pin.reader()
        pin.release()
        self.registry.abandon(value.lease, 'telemetry_lost')
        value.owner.release_playback(value.playback)
        self.registry.reap_cleanup()
        self.assertEqual(value.owner.try_close(), 'pending')
        self.assertEqual(len(self.registry._slots), 1)
        self.assertEqual(value.resource.closes, 0)
        self.assertEqual(reader.read(10), b'controlled')
        reader.close()
        self.registry.reap_cleanup()
        self.assertEqual(len(self.registry._slots), 0)
        self.assertEqual(value.resource.closes, 1)
        self.assertEqual(value.resource.streams[0].close_attempts, 1)

    def test_reader_close_uncertainty_retains_exact_responsibility(self):
        value = self.attached()
        pin = value.owner.pin_playback(value.playback)
        reader = pin.reader()
        pin.release()
        value.resource.streams[0].fail_close = True
        with self.assertRaises(OSError):
            reader.close()
        self.retire(value)
        for _ in range(3):
            self.registry.reap_cleanup()
        self.assertEqual(value.resource.streams[0].close_attempts, 1)
        self.assertEqual(len(self.registry._slots), 1)
        self.assertFalse(value.rooted.drained.is_set())
        self.assertTrue(value.rooted.cleanup_failed)

    def test_physical_mutation_is_sticky_after_restoration(self):
        value = self.attached()
        pin = self.pin(value)
        value.resource.mutated = True
        with self.assertRaises(self.m.rooted.RootedFileUnavailable):
            pin.check()
        count = value.resource.checks
        value.resource.mutated = False
        self.assertTrue(value.source._failed)
        self.assertTrue(value.rooted._failed)
        with self.unavailable('source_failed'):
            self.playback_check(value)
        self.assertEqual(value.resource.checks, count)
        self.assertEqual(value.lease.reason, 'source_check_failed')
        pin.release()
        self.retire(value)

    def test_concurrent_close_attempt_is_once_and_outside_owner_mutex(self):
        value = self.source()
        barrier = Barrier()
        value.resource.close_barrier = barrier
        task = Task(lambda: value.owner.release_playback(value.playback))
        try:
            barrier.reached()
            self.assertTrue(value.owner._state.acquire(blocking=False))
            value.owner._state.release()
            self.assertEqual(value.owner.try_close(), 'pending')
            self.assertEqual(value.resource.closes, 1)
        finally:
            barrier.resume.set()
            task.finish()
        self.assertIsNone(task.error)
        self.assertEqual(value.owner.try_close(), 'disposed')
        self.assertEqual(value.resource.closes, 1)

    def test_pending_reader_drain_never_retries_raw_close(self):
        value = self.source()
        pin = value.owner.pin_playback(value.playback)
        reader = pin.reader()
        pin.release()
        original = self.m.retained.RetainedPlaybackSource.close
        calls = []
        def counted(source):
            calls.append(source)
            return original(source)
        with patch.object(self.m.retained.RetainedPlaybackSource, 'close', counted):
            value.owner.release_playback(value.playback)
            for _ in range(3):
                self.assertEqual(value.owner.try_close(), 'pending')
            self.assertEqual(calls, [value.source])
            self.assertEqual(value.resource.closes, 0)
            reader.close()
            self.assertEqual(value.owner.try_close(), 'disposed')
            self.assertEqual(calls, [value.source])
        self.assertEqual(value.resource.closes, 1)
