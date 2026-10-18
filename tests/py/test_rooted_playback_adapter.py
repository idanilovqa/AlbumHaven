"""Independent finite source-authored cases. NOT EXECUTED or runtime-approved."""
import asyncio
from dataclasses import FrozenInstanceError
import io
import types
from unittest.mock import patch

from rooted_adapter_memory import Case, Factory, Pipe, Process, forbidden


class AdmissionCases(Case):
    async def test_capacity_duplicate_and_explicit_transfer(self):
        pairs = [self.admit() for _ in range(8)]
        self.assertEqual(len(self.pool._records), 8)
        ninth = self.source()
        with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'lifecycle_capacity'):
            self.pool.admit(ninth.owner, ninth.playback)
        self.assertTrue(ninth.playback.live)
        self.assertEqual(ninth.resource.closes, 0)
        # Caller retains P after known rejection; caller closes only this source.
        ninth.owner.release_playback(ninth.playback)
        self.assertEqual(ninth.resource.closes, 1)
        source, record = pairs[0]
        record.request_cancel()
        await self.pump(lambda: record._driver.done())
        await self.pump(lambda: record not in self.pool._records)
        self.assertFalse(source.playback.live)
        self.assertEqual(source.resource.closes, 1)
        source, record = pairs[1]
        with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'owner_already_admitted'):
            self.pool.admit(source.owner, source.playback)

    async def test_limits_reject_before_transfer(self):
        for limit in (True, False, 0, 9, 1.5):
            with self.subTest(limit=limit), self.assertRaises((ValueError, TypeError)):
                self.m.adapter.BoundedPhysicalRunner(limit)
            runner = self.m.adapter.BoundedPhysicalRunner()
            with self.subTest(pool_limit=limit), self.assertRaises((ValueError, TypeError)):
                self.m.adapter.RootedPlaybackLifecyclePool(physical_runner=runner, limit=limit)
        self.assertEqual(len(self.pool._records), 0)

    async def test_never_started_cancel_and_source_close_failure_remain_honest(self):
        source, record = self.admit()
        source.resource.fail_close = True
        record.request_cancel()
        record.request_cancel()
        await self.pump(lambda: record._driver.done())
        self.assertFalse(source.playback.live)
        self.assertEqual(source.resource.closes, 1)
        self.assertTrue(record._cleanup_failed)
        self.assertIn(record, self.pool._records)
        record.request_disposal_poll()
        for _ in range(3):
            self.threads.tick()
            await asyncio.sleep(0)
        self.assertEqual(source.resource.closes, 1)

    async def test_start_cancelled_before_body_uses_caller_finally(self):
        source, record = self.admit()
        task = self.caller(record.start(self.command(), capability=None))
        task.cancel()
        try:
            with self.assertRaises(asyncio.CancelledError):
                await task
        finally:
            record.request_cancel()
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(source.resource.reader_opens, 0)
        self.assertEqual(source.resource.closes, 1)

    async def test_driver_allocation_uncertainty_is_accepted_charged(self):
        source = self.source()
        loop = asyncio.get_running_loop()
        original = loop.create_task
        scheduled = []
        def schedule_then_fail(coroutine, *args, **kwargs):
            scheduled.append(original(coroutine, *args, **kwargs))
            raise MemoryError('after scheduling')
        with patch.object(loop, 'create_task', schedule_then_fail):
            record = self.pool.admit(source.owner, source.playback)
        self.records.append(record)
        self.callers.extend(scheduled)
        self.assertTrue(record._admitted)
        self.assertTrue(record._task_creation_failed)
        self.assertTrue(source.playback.live)
        self.assertIn(record, self.pool._records)
        await self.pump(lambda: scheduled[0].done())
        self.assertIn(record, self.pool._records)

    async def test_stalled_worker_cancel_is_synchronous_and_does_not_replace_slot(self):
        source, record = self.admit()
        self.threads.hold = True
        record.request_cancel()
        for _ in range(6):
            await asyncio.sleep(0)
        self.assertIsNotNone(record._physical)
        self.assertTrue(source.playback.live)
        self.assertEqual(source.resource.closes, 0)
        record.request_cancel()
        self.assertEqual(sum(t.starts for t in self.threads.threads), 1)
        self.threads.hold = False
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(source.resource.closes, 1)
        self.assertTrue(all(t.starts <= 1 for t in self.threads.threads))

    async def test_foreign_loop_rejects_but_sync_cancel_allowed(self):
        source, record, decoder, process, factory = await self.start()
        real_loop = record._loop
        # Identity mismatch is the source's exact guard; no second real loop/thread.
        record._loop = object()
        try:
            with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'foreign_execution_loop'):
                decoder.grant_credit(1)
            with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'foreign_execution_loop'):
                await decoder.read_credited_frames(max_frames=1)
            with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'foreign_execution_loop'):
                await decoder.finish()
        finally:
            record._loop = real_loop
        decoder.request_cancel()
        await self.pump(lambda: record not in self.pool._records)


class ProcessCases(Case):
    async def test_non_mp3_uses_retained_fd_never_path_helpers(self):
        with patch.object(self.m.mp3, 'ignored_mp3_gapless_info', forbidden), \
             patch.object(self.m.mp3, 'read_mp3_gapless_info', forbidden), \
             patch.object(self.m.pcm, 'resolve_ffmpeg_executable', forbidden):
            source, record, decoder, process, factory = await self.start()
        self.assertEqual(len(factory.calls), 1)
        self.assertEqual(source.resource.reader_opens, 1)
        self.assertEqual(source.resource.streams[0].close_attempts, 1)
        self.assertGreater(source.resource.checks, 1)

    async def test_unknown_factory_failure_keeps_ticket_and_p(self):
        source, record = self.admit()
        factory = Factory(OSError('unknown spawn outcome'))
        cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake'), protocol='fd')
        task = self.caller(record.start(self.command(), capability=cap,
            process_factory=factory, capability_probe=types.SimpleNamespace(matches=lambda _: True),
            pipe_completion=lambda _: True))
        await self.pump(task.done)
        # Observe the failure without clearing a still-live owner traceback.
        self.assertIsInstance(task.exception(), OSError)
        await self.pump(lambda: record._driver.done())
        self.assertIn(record, self.pool._records)
        self.assertIsNotNone(source.owner._child)
        self.assertTrue(source.playback.live)
        self.assertEqual(source.resource.closes, 0)

    async def test_explicit_no_child_proof_disposes_once(self):
        source, record = self.admit()
        cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake'), protocol='fd')
        task = self.caller(record.start(self.command(), capability=cap,
            process_factory=Factory(self.m.adapter.NoChildCreated()),
            capability_probe=types.SimpleNamespace(matches=lambda _: True), pipe_completion=lambda _: True))
        await self.pump(task.done)
        # Observe the failure without clearing a still-live owner traceback.
        self.assertIsInstance(task.exception(), self.m.adapter.NoChildCreated)
        await self.pump(lambda: record not in self.pool._records)
        self.assertIsNone(source.owner._child)
        self.assertEqual(source.resource.closes, 1)

    async def test_spawn_cancel_retains_reader_until_late_child_reaped(self):
        source, record = self.admit()
        process = Process()
        factory = Factory(process)
        factory.gate = asyncio.Event()
        cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake'), protocol='fd')
        task = self.caller(record.start(self.command(), capability=cap, process_factory=factory,
            capability_probe=types.SimpleNamespace(matches=lambda _: True), pipe_completion=lambda _: True))
        await self.pump(lambda: bool(factory.calls))
        task.cancel()
        record.request_cancel()
        self.assertIsNotNone(source.owner._child)
        self.assertEqual(source.resource.streams[0].close_attempts, 0)
        self.assertTrue(source.playback.live)
        factory.gate.set()
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(process.waits, 1)
        self.assertEqual(process.kills, 1)
        self.assertEqual(source.resource.streams[0].close_attempts, 1)
        self.assertEqual(source.resource.closes, 1)

    async def test_eof_wait_without_exact_pipe_proof_retains(self):
        for proof in (False, 1):
            with self.subTest(proof=proof):
                source, record, decoder, process, factory = await self.start(proof=proof)
                decoder.request_cancel()
                await self.pump(lambda: record._driver.done())
                self.assertEqual(process.waits, 1)
                self.assertIn(record, self.pool._records)
                self.assertIsNotNone(source.owner._child)
                self.assertTrue(source.playback.live)

    async def test_missing_pipe_waits_and_truthful_proof_settles(self):
        for missing in ('stdout', 'stderr', 'both'):
            with self.subTest(missing=missing):
                source, record = self.admit()
                process = Process()
                if missing in ('stdout', 'both'):
                    process.stdout = None
                if missing in ('stderr', 'both'):
                    process.stderr = None
                cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake'), protocol='fd')
                task = self.caller(record.start(self.command(), capability=cap,
                    process_factory=Factory(process), capability_probe=types.SimpleNamespace(matches=lambda _: True),
                    pipe_completion=lambda _: True))
                await self.pump(task.done)
                # Observe the failure without clearing a still-live owner traceback.
                self.assertIsInstance(task.exception(), self.m.adapter.AdapterUnavailable)
                self.assertRegex(str(task.exception()), 'missing_process_pipe')
                await self.pump(lambda: record not in self.pool._records)
                self.assertEqual(process.waits, 1)
                self.assertEqual(source.resource.closes, 1)

    async def test_reader_close_failure_remains_charged_after_reap(self):
        source = self.source()
        source.resource.reader_close_error = True
        source, record = self.admit(source)
        process = Process()
        cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake'), protocol='fd')
        task = self.caller(record.start(self.command(), capability=cap,
            process_factory=Factory(process), capability_probe=types.SimpleNamespace(matches=lambda _: True),
            pipe_completion=lambda _: True))
        await self.pump(task.done)
        # Observe the failure without clearing a still-live owner traceback.
        self.assertIsInstance(task.exception(), OSError)
        await self.pump(lambda: record._driver.done())
        self.assertEqual(process.waits, 1)
        self.assertEqual(source.resource.streams[0].close_attempts, 1)
        self.assertIn(record, self.pool._records)
        self.assertTrue(source.playback.live)
        self.assertEqual(source.resource.closes, 0)

    async def test_probe_collection_8192_8193_and_single_reader(self):
        # Isolates actual probe collector with a real admission; no process launch.
        source, record = self.admit()
        record._process = Process(stdout=Pipe(b'x' * 4096, b'y' * 4096))
        output = await record._probe_output()
        self.assertEqual(len(output), 8192)
        self.assertEqual(record._process.stdout.peak, 1)
        record._process = Process(stdout=Pipe(b'x' * 8193))
        with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'probe_output_limit'):
            await record._probe_output()
        self.assertEqual(sum(record._process.stdout.reads), 8193)
        record._process = None  # Collector-only seam had no child ticket.

    async def test_parser_fixed_read_budget_and_rejects_oversized_buffers(self):
        source = self.source('.mp3', b'not a valid mpeg header' * 500)
        source.resource.fragment = 7
        reader = source.resource.reader()
        self.assertIsNone(self.m.adapter._read_header(reader))
        self.assertLessEqual(reader.tell(), 4096)
        self.assertTrue(all(0 <= n <= 4096 for n in reader.read_sizes))
        reader.close()
        for header, frame in ((b'x' * 11, b''), (b'', b'x' * 4097)):
            with self.assertRaises(ValueError):
                self.m.adapter.parse_gapless_header(header, frame, 10000, 0)
        source.owner.release_playback(source.playback)


class CreditEvidenceCases(Case):
    async def test_combined_credit_cap_and_short_read_refund(self):
        pipe = Pipe(b'a' * 24)
        source, record, decoder, process, factory = await self.start(Process(stdout=pipe))
        pipe.gate = asyncio.Event()
        maximum = self.m.adapter.UINT32_MAX
        decoder.grant_credit(maximum)
        task = self.caller(decoder.read_credited_frames(max_frames=maximum))
        await self.pump(lambda: pipe.active == 1)
        self.assertEqual(record._reserved, 8192)
        self.assertEqual(record._available, maximum - 8192)
        with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'credit_capacity'):
            decoder.grant_credit(8192)
        pipe.gate.set()
        chunk = await self.result(task)
        self.assertEqual(chunk.frame_count, 3)
        self.assertEqual(record._available, maximum - 3)
        self.assertEqual(record._reserved, 0)
        self.assertEqual(pipe.reads[0], 65536)
        decoder.request_cancel()
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(record._available, maximum - 3)

    async def test_read_error_refunds_once_and_never_resumes(self):
        pipe = Pipe(b'abc', OSError('pipe failure'), b'12345678')
        source, record, decoder, process, factory = await self.start(Process(stdout=pipe))
        decoder.grant_credit(10)
        with self.assertRaises(OSError):
            await self.read(decoder)
        self.assertEqual((record._available, record._reserved, record._emitted), (10, 0, 0))
        self.assertTrue(record._decode_failed)
        with self.assertRaises(self.m.adapter.AdapterUnavailable):
            await decoder.read_credited_frames(max_frames=1)
        with self.assertRaises(self.m.adapter.AdapterUnavailable):
            await decoder.finish()
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(record._available, 10)
        self.assertEqual(pipe.peak, 1)

    async def test_headroom_grant_full_refund_and_busy_no_queue(self):
        pipe = Pipe(OSError('terminal'))
        source, record, decoder, process, factory = await self.start(Process(stdout=pipe))
        pipe.gate = asyncio.Event()
        decoder.grant_credit(10)
        task = self.caller(decoder.read_credited_frames(max_frames=10))
        await self.pump(lambda: pipe.active == 1)
        decoder.grant_credit(7)
        with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'decoder_operation_unavailable'):
            await decoder.read_credited_frames(max_frames=1)
        with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'decoder_operation_unavailable'):
            await decoder.finish()
        pipe.gate.set()
        await self.pump(task.done)
        with self.assertRaises(OSError):
            task.result()
        self.assertEqual((record._available, record._reserved), (17, 0))

    async def test_cancel_wins_late_read_and_refunds_once(self):
        pipe = Pipe(b'a' * 8)
        source, record, decoder, process, factory = await self.start(Process(stdout=pipe))
        pipe.gate = asyncio.Event()
        decoder.grant_credit(1)
        task = self.caller(decoder.read_credited_frames(max_frames=1))
        await self.pump(lambda: pipe.active == 1)
        decoder.request_cancel()
        decoder.request_cancel()
        pipe.gate.set()
        await self.pump(task.done)
        with self.assertRaises(asyncio.CancelledError):
            task.result()
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual((record._available, record._reserved, record._emitted), (1, 0, 0))
        self.assertEqual(process.kills, 1)
        self.assertEqual(pipe.peak, 1)

    async def test_chunk_allocation_failure_is_terminal(self):
        source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8)))
        decoder.grant_credit(2)
        def fail(**kwargs):
            raise MemoryError('mandatory PCM chunk')
        with patch.object(self.m.pcm, 'PcmChunk', fail), self.assertRaises(MemoryError):
            await self.read(decoder)
        self.assertEqual((record._available, record._reserved, record._emitted), (2, 0, 0))
        self.assertTrue(record._decode_failed)
        with self.assertRaises(self.m.adapter.AdapterUnavailable):
            await decoder.read_credited_frames(max_frames=1)

    async def test_observation_allocations_preserve_pcm_and_sticky_loss(self):
        for name in ('DecodedRange', 'DecodedPrefixSnapshot'):
            with self.subTest(allocation=name):
                source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8, b'b' * 8)))
                decoder.grant_credit(2)
                old = decoder.observation_snapshot(decoder.lifecycle_id)
                def fail(*args, **kwargs):
                    raise MemoryError('optional observation')
                with patch.object(self.m.adapter, name, fail):
                    chunk = await self.read(decoder, 1)
                self.assertEqual(chunk.frame_count, 1)
                self.assertEqual((record._available, record._reserved, record._emitted), (1, 0, 1))
                self.assertFalse(record._decode_failed)
                self.assertFalse(record._cancel_requested)
                self.assertEqual(process.kills, 0)
                self.assertTrue(old.evidence_valid)
                self.assertFalse(decoder.observation_snapshot(decoder.lifecycle_id).evidence_valid)
                chunk = await self.read(decoder, 1)
                self.assertEqual(chunk.frame_count, 1)
                self.assertFalse(decoder.observation_snapshot(decoder.lifecycle_id).evidence_valid)

    async def test_zero_start_eos_local_candidate_and_nonzero_exclusion(self):
        for start in (0, 5):
            with self.subTest(start=start):
                source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 16)), start=start)
                decoder.grant_credit(4)
                await self.read(decoder)
                await self.read(decoder)
                snapshot = decoder.observation_snapshot(decoder.lifecycle_id)
                self.assertEqual((snapshot.start_frame, snapshot.end_frame), (start, start + 2))
                self.assertEqual(snapshot.candidate is not None, start == 0)
                if start == 0:
                    self.assertEqual(snapshot.candidate.total_frames, 2)
                    self.assertIs(snapshot.candidate.lifecycle_id, record.lifecycle_id)
                    self.assertFalse(hasattr(snapshot.candidate, 'decoder_uuid'))
                self.assertEqual(decoder.metadata.provisional_total_frames, 999 * 48000)

    async def test_snapshots_are_immutable_cumulative_identity_bound(self):
        source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8, b'b' * 16)))
        decoder.grant_credit(3)
        await self.read(decoder, 1)
        old = decoder.observation_snapshot(decoder.lifecycle_id)
        await self.read(decoder, 2)
        new = decoder.observation_snapshot(decoder.lifecycle_id)
        self.assertEqual((old.end_frame, new.end_frame), (1, 3))
        with self.assertRaises(FrozenInstanceError):
            old.end_frame = 99
        with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'lifecycle_identity_mismatch'):
            decoder.observation_snapshot(self.m.adapter.LifecycleId())
        decoder.mark_observation_lost(decoder.lifecycle_id, 'consumer_failure')
        current = decoder.observation_snapshot(decoder.lifecycle_id)
        self.assertFalse(current.evidence_valid)
        self.assertIsNone(current.candidate)
        self.assertFalse(record._cancel_requested)

    async def test_real_registry_e_first_and_p_first_orderings(self):
        for e_first in (True, False):
            with self.subTest(e_first=e_first):
                source = self.source()
                binding = self.m.leases.SourceBinding('epoch', 'account', 'library', 'session',
                    'device', 'logical', 'track', 'file', 'root', 48000)
                lease = self.registry.attach(self.registry.reserve('account'), source.owner, source.playback, binding)
                source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8)), source=source)
                if e_first:
                    self.registry.abandon(lease, 'test_complete')
                    self.assertTrue(source.playback.live)
                    self.assertFalse(record._cancel_requested)
                decoder.grant_credit(2)
                self.assertEqual((await self.read(decoder)).frame_count, 1)
                await self.read(decoder)
                if not e_first:
                    await self.pump(lambda: record._phase == 'retained_pending')
                    self.assertIn(record, self.pool._records)
                    self.assertEqual(source.resource.closes, 0)
                    self.registry.abandon(lease, 'test_complete')
                    self.registry.reap_cleanup()
                    record.request_disposal_poll()
                await self.pump(lambda: record not in self.pool._records)
                self.assertEqual(source.resource.closes, 1)

    async def test_candidate_allocation_failure_preserves_successful_eos(self):
        source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8)))
        decoder.grant_credit(2)
        await self.read(decoder)
        def fail(*args, **kwargs):
            raise MemoryError('candidate only')
        with patch.object(self.m.adapter, 'VerifiedExtentCandidate', fail):
            self.assertEqual((await self.read(decoder)).frame_count, 0)
        self.assertFalse(record._decode_failed)
        self.assertFalse(record._cancel_requested)
        snapshot = decoder.observation_snapshot(decoder.lifecycle_id)
        self.assertFalse(snapshot.evidence_valid)
        self.assertIsNone(snapshot.candidate)
        self.assertEqual(record._emitted, 1)

    async def test_mandatory_position_overflow_is_terminal_with_full_refund(self):
        source, record, decoder, process, factory = await self.start(
            Process(stdout=Pipe(b'a' * 8)), start=self.m.adapter.SAFE_INTEGER)
        decoder.grant_credit(1)
        with self.assertRaises(ValueError):
            await self.read(decoder, 1)
        self.assertEqual((record._available, record._reserved, record._emitted), (1, 0, 0))
        self.assertTrue(record._decode_failed)

    async def test_snapshot_reconstruction_failure_only_invalidates_evidence(self):
        source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8)))
        decoder.mark_observation_lost(decoder.lifecycle_id, 'consumer_failure')
        def fail(*args, **kwargs):
            raise MemoryError('snapshot reconstruction')
        with patch.object(self.m.adapter, 'DecodedPrefixSnapshot', fail):
            with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'observation_unavailable'):
                decoder.observation_snapshot(decoder.lifecycle_id)
        self.assertFalse(record._decode_failed)
        self.assertFalse(record._cancel_requested)
        decoder.grant_credit(1)
        self.assertEqual((await self.read(decoder)).frame_count, 1)
        self.assertFalse(decoder.observation_snapshot(decoder.lifecycle_id).evidence_valid)


class ReviewedRegressionCases(Case):
    async def test_duplicate_start_rejection_does_not_cancel_winner(self):
        source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8)))
        cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake'), protocol='fd')
        with self.assertRaises(self.m.adapter.AdapterUnavailable):
            await self.m.pcm.PcmDecoderProcess.start_retained(self.command(), admission=record,
                capability=cap, process_factory=factory,
                capability_probe=types.SimpleNamespace(matches=lambda _: True), pipe_completion=lambda _: True)
        self.assertFalse(record._cancel_requested)
        self.assertEqual(process.kills, 0)
        decoder.grant_credit(1)
        self.assertEqual((await self.read(decoder)).frame_count, 1)

    async def test_foreign_start_rejection_does_not_cancel_winner(self):
        source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8)))
        old_loop = record._loop
        record._loop = object()
        try:
            with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'foreign_execution_loop'):
                await self.m.pcm.PcmDecoderProcess.start_retained(
                    self.command(), admission=record, capability=None, process_factory=factory)
        finally:
            record._loop = old_loop
        self.assertFalse(record._cancel_requested)
        decoder.grant_credit(1)
        self.assertEqual((await self.read(decoder)).frame_count, 1)

    async def test_stdout_cancelled_before_first_body_refunds_and_terminates(self):
        source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8)))
        decoder.grant_credit(3)
        loop = asyncio.get_running_loop()
        original = loop.create_task
        def cancelled_stdout(coroutine, *args, **kwargs):
            task = original(coroutine, *args, **kwargs)
            if coroutine.cr_code.co_name == '_read_output':
                task.cancel()
            return task
        with patch.object(loop, 'create_task', cancelled_stdout):
            task = self.caller(decoder.read_credited_frames(max_frames=3))
            await self.pump(task.done)
            with self.assertRaises(asyncio.CancelledError):
                task.result()
        await self.pump(lambda: record._decode_failed)
        self.assertEqual((record._available, record._reserved, record._emitted), (3, 0, 0))
        with self.assertRaises(self.m.adapter.AdapterUnavailable):
            await decoder.read_credited_frames(max_frames=1)
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(record._available, 3)

    async def test_finish_task_cancelled_before_body_is_terminal(self):
        source, record, decoder, process, factory = await self.start()
        process.stdout.eof = True
        loop = asyncio.get_running_loop()
        original = loop.create_task
        def cancelled_stdout(coroutine, *args, **kwargs):
            task = original(coroutine, *args, **kwargs)
            if coroutine.cr_code.co_name == '_finish_output':
                task.cancel()
            return task
        with patch.object(loop, 'create_task', cancelled_stdout):
            task = self.caller(decoder.finish())
            await self.pump(task.done)
            with self.assertRaises(asyncio.CancelledError):
                task.result()
        await self.pump(lambda: record._decode_failed)
        self.assertIsNone(record._candidate)
        with self.assertRaises(self.m.adapter.AdapterUnavailable):
            await decoder.finish()

    async def test_driver_coroutine_allocation_failure_has_no_phantom_admission(self):
        source = self.source()
        def allocation_failure(*args):
            raise MemoryError('coroutine allocation')
        with patch.object(self.m.adapter.RootedPlaybackAdmission, '_drive', allocation_failure):
            with self.assertRaises(MemoryError):
                self.pool.admit(source.owner, source.playback)
        self.assertEqual(len(self.pool._records), 0)
        self.assertTrue(source.playback.live)
        self.assertEqual(source.resource.closes, 0)
        source.owner.release_playback(source.playback)
        self.assertEqual(source.resource.closes, 1)

    async def test_only_one_async_cancel_observer_is_admitted(self):
        process = Process()
        process.wait_gate = asyncio.Event()
        source, record, decoder, process, factory = await self.start(process)
        loop = asyncio.get_running_loop()
        original_later = loop.call_later
        cancel_timers = []
        def observed_later(delay, callback, *args, **kwargs):
            handle = original_later(delay, callback, *args, **kwargs)
            if delay == 2.0:
                cancel_timers.append(handle)
            return handle
        with patch.object(loop, 'call_later', observed_later):
            first = self.caller(decoder.cancel())
            await self.pump(lambda: process.kills == 1 and record._cancel_observing)
            self.assertEqual(len(cancel_timers), 1)
            for _ in range(8):
                with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'cleanup_observer_busy'):
                    await decoder.cancel()
                self.assertEqual(len(cancel_timers), 1)
        self.assertFalse(first.done())
        self.assertEqual(process.waits, 1)
        process.wait_gate.set()
        await self.result(first)
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(process.kills, 1)


class AdditionalBoundaries(Case):
    async def test_capability_denied_before_factory_and_source_mutation_after_decode(self):
        for available, protocol in ((False, 'fd'), (True, 'pipe')):
            source, record = self.admit()
            factory = Factory(Process())
            cap = types.SimpleNamespace(available=available, identity=types.SimpleNamespace(path='fake'), protocol=protocol)
            task = self.caller(record.start(self.command(), capability=cap, process_factory=factory,
                capability_probe=types.SimpleNamespace(matches=lambda _: True), pipe_completion=lambda _: True))
            await self.pump(task.done)
            # Observe the failure without clearing a still-live owner traceback.
            self.assertIsInstance(task.exception(), self.m.adapter.AdapterUnavailable)
            self.assertRegex(str(task.exception()), 'capability_unavailable')
            await self.pump(lambda: record not in self.pool._records)
            self.assertEqual(factory.calls, [])
            self.assertEqual(source.resource.reader_opens, 0)
        source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8)))
        decoder.grant_credit(2)
        await self.read(decoder)
        source.resource.mutated = True
        task = self.caller(decoder.read_credited_frames(max_frames=1))
        await self.pump(task.done)
        # Rooted checks preserve their failure without clearing the owner traceback.
        self.assertIsInstance(task.exception(), self.m.rooted.RootedFileUnavailable)
        self.assertRegex(str(task.exception()), '^source_changed$')
        self.assertIsNone(record._candidate)
        self.assertTrue(record._decode_failed)

    async def test_probe_reap_and_transport_proof_precede_decoder(self):
        frame = bytearray(417)
        frame[:4] = bytes.fromhex('fffb9000')
        frame[36:40] = b'Xing'
        frame[40:44] = (1).to_bytes(4, 'big')
        frame[44:48] = (3).to_bytes(4, 'big')
        frame[48:52] = b'Lame'
        source = self.source('.mp3', bytes(frame) + b'\0' * 1000)
        source, record = self.admit(source)
        probe_child = Process(stdout=Pipe(b'#codec_id 0: mp3\n', b'Skip Samples\n'))
        probe_child.wait_gate = asyncio.Event()
        decoder_child = Process(stdout=Pipe(b'a' * 8))
        factory = Factory(probe_child, decoder_child)
        disposed = []
        def proof(child):
            self.assertEqual(child.waits, 1)
            self.assertTrue(child.stdout.eof)
            self.assertTrue(child.stderr.eof)
            disposed.append(child)
            return True
        cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake'), protocol='fd')
        task = self.caller(self.m.pcm.PcmDecoderProcess.start_retained(self.command(suffix='.mp3'),
            admission=record, capability=cap, process_factory=factory,
            capability_probe=types.SimpleNamespace(matches=lambda _: True), pipe_completion=proof))
        await self.pump(lambda: probe_child.waits == 1 and probe_child.stdout.eof)
        self.assertEqual(len(factory.calls), 1)
        self.assertEqual(disposed, [])
        self.assertTrue(source.playback.live)
        probe_child.wait_gate.set()
        decoder = await self.result(task)
        self.assertEqual(disposed, [probe_child])
        self.assertEqual(len(factory.calls), 2)
        self.assertIsNone(record.gapless)
        decoder.request_cancel()

    async def test_reap_pending_and_failed_pipe_do_not_skip_other_owner(self):
        process = Process(stdout=Pipe(OSError('stdout failed')), stderr=Pipe(b'diagnostic'))
        process.wait_gate = asyncio.Event()
        source, record, decoder, process, factory = await self.start(process)
        decoder.request_cancel()
        await self.pump(lambda: process.stdout.reads and process.stderr.eof)
        self.assertEqual(process.waits, 1)
        self.assertIn(record, self.pool._records)
        self.assertTrue(source.playback.live)
        self.assertIsNotNone(source.owner._child)
        process.wait_gate.set()
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(source.resource.closes, 1)
        self.assertEqual(process.kills, 1)
        self.assertEqual(process.stdout.peak, 1)
        self.assertEqual(process.stderr.peak, 1)


class PendingOwnershipRegressions(Case):
    async def test_duplicate_start_before_ready_does_not_cancel_winning_claim(self):
        source, record = self.admit()
        process = Process(stdout=Pipe(b'a' * 8))
        factory = Factory(process)
        factory.gate = asyncio.Event()
        cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake'), protocol='fd')
        probe = types.SimpleNamespace(matches=lambda value: value is cap)
        command = self.command()
        winner = self.caller(self.m.pcm.PcmDecoderProcess.start_retained(command,
            admission=record, capability=cap, process_factory=factory,
            capability_probe=probe, pipe_completion=lambda _: True))
        await self.pump(lambda: len(factory.calls) == 1)
        claim = record._start_claim
        child = source.owner._child
        self.assertIsNotNone(claim)
        self.assertIsNotNone(child)
        self.assertFalse(record._ready)
        self.assertFalse(winner.done())
        self.assertEqual(source.resource.streams[0].close_attempts, 0)
        with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'start_unavailable'):
            await self.m.pcm.PcmDecoderProcess.start_retained(command,
                admission=record, capability=cap, process_factory=factory,
                capability_probe=probe, pipe_completion=lambda _: True)
        self.assertIs(record._start_claim, claim)
        self.assertIs(source.owner._child, child)
        self.assertFalse(record._cancel_requested)
        self.assertFalse(winner.done())
        self.assertTrue(source.playback.live)
        self.assertEqual(len(factory.calls), 1)
        self.assertEqual(process.kills, 0)
        factory.gate.set()
        decoder = await self.result(winner)
        self.assertTrue(record._ready)
        self.assertFalse(record._cancel_requested)
        decoder.grant_credit(1)
        self.assertEqual((await self.read(decoder, 1)).frame_count, 1)
        self.assertEqual(len(factory.calls), 1)
        decoder.request_cancel()
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(source.resource.closes, 1)

    async def test_cancelled_caller_retains_pending_shielded_read_until_exact_refund(self):
        pipe = Pipe(b'a' * 8)
        source, record, decoder, process, factory = await self.start(Process(stdout=pipe))
        pipe.gate = asyncio.Event()
        decoder.grant_credit(5)
        caller = self.caller(decoder.read_credited_frames(max_frames=3))
        await self.pump(lambda: pipe.active == 1)
        stdout_owner = record._stdout_task
        operation = record._stdout_operation
        child = source.owner._child
        self.assertIsNotNone(operation)
        self.assertIsNotNone(child)
        self.assertEqual((record._available, record._reserved, record._emitted), (2, 3, 0))
        caller.cancel()
        await self.pump(caller.done)
        with self.assertRaises(asyncio.CancelledError):
            caller.result()
        # Caller cancellation is not stdout completion or credit settlement.
        self.assertFalse(stdout_owner.done())
        self.assertFalse(stdout_owner.cancelled())
        self.assertIs(record._stdout_task, stdout_owner)
        self.assertIs(record._stdout_operation, operation)
        self.assertIs(source.owner._child, child)
        self.assertTrue(record._operation_busy)
        self.assertTrue(record._reservation_live)
        self.assertTrue(record._cancel_requested)
        self.assertEqual((record._available, record._reserved, record._emitted), (2, 3, 0))
        self.assertTrue(source.playback.live)
        self.assertEqual(source.resource.closes, 0)
        self.assertIn(record, self.pool._records)
        self.assertEqual(pipe.active, 1)
        self.assertEqual(len(pipe.reads), 1)
        with self.assertRaises(self.m.adapter.AdapterUnavailable):
            await decoder.read_credited_frames(max_frames=1)
        with self.assertRaises(self.m.adapter.AdapterUnavailable):
            await decoder.finish()
        record.request_cancel()  # Repeated publication cannot refund early.
        self.assertEqual((record._available, record._reserved), (2, 3))
        pipe.gate.set()
        await self.pump(lambda: record not in self.pool._records)
        self.assertTrue(stdout_owner.done())
        self.assertTrue(record._decode_failed)
        self.assertEqual((record._available, record._reserved, record._emitted), (5, 0, 0))
        self.assertFalse(record._reservation_live)
        self.assertIsNone(record._candidate)
        self.assertEqual(pipe.peak, 1)
        self.assertEqual(process.kills, 1)
        self.assertEqual(process.waits, 1)
        self.assertEqual(source.resource.closes, 1)
        # Completed late callbacks cannot settle the same reservation twice.
        for _ in range(3):
            self.threads.tick()
            await asyncio.sleep(0)
        self.assertEqual((record._available, record._reserved, record._emitted), (5, 0, 0))

    async def test_invalid_command_and_foreign_thread_identity_preserve_winner(self):
        source, record, decoder, process, factory = await self.start(Process(stdout=Pipe(b'a' * 8)))
        with self.assertRaisesRegex(TypeError, 'pcm_open_command_required'):
            await self.m.pcm.PcmDecoderProcess.start_retained(types.SimpleNamespace(),
                admission=record, capability=None, process_factory=factory)
        original_identity = self.threads.get_ident()
        with patch.object(self.threads, 'get_ident', lambda: original_identity + 1):
            with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'foreign_execution_loop'):
                await self.m.pcm.PcmDecoderProcess.start_retained(self.command(),
                    admission=record, capability=None, process_factory=factory)
            with self.assertRaisesRegex(self.m.adapter.AdapterUnavailable, 'foreign_execution_loop'):
                decoder.grant_credit(1)
        self.assertFalse(record._cancel_requested)
        self.assertEqual(process.kills, 0)
        self.assertTrue(source.playback.live)
        decoder.grant_credit(1)
        self.assertEqual((await self.read(decoder)).frame_count, 1)

    async def test_owned_facade_allocation_failure_cancels_and_settles_claim(self):
        source, record = self.admit()
        process = Process()
        factory = Factory(process)
        cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake'), protocol='fd')
        def fail_wrapper(*args, **kwargs):
            raise MemoryError('owned facade allocation')
        with patch.object(self.m.pcm, 'RetainedPcmDecoderProcess', fail_wrapper):
            task = self.caller(self.m.pcm.PcmDecoderProcess.start_retained(self.command(),
                admission=record, capability=cap, process_factory=factory,
                capability_probe=types.SimpleNamespace(matches=lambda _: True),
                pipe_completion=lambda _: True))
            await self.pump(task.done)
            with self.assertRaises(MemoryError):
                task.result()
        self.assertTrue(record._cancel_requested)
        await self.pump(lambda: record not in self.pool._records)
        self.assertEqual(len(factory.calls), 1)
        self.assertEqual(process.kills, 1)
        self.assertEqual(process.waits, 1)
        self.assertEqual(source.resource.closes, 1)
        self.assertFalse(source.playback.live)
