"""Dormant same-source PCM lifecycle. No application composition or activation.

Native spawn errors and pipe disposal are conservatively uncertain unless a
trusted, independently reviewed process contract proves otherwise. A charged
record is never evicted to manufacture cleanup. All physical methods run on the
explicit bounded runner; imports construct neither workers nor playback owners.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import math
import threading

from music_app.services.retained_playback_source import (
    SharedPlaybackSourceOwner, SourceUnavailable,
)
from music_app.services.mp3_gapless import Mp3GaplessInfo
from music_app.services.ffmpeg_runtime import hidden_subprocess_creation_flags
from music_app.services.ffmpeg_source_capability import DEFAULT_SOURCE_CAPABILITY_PROBE

UINT32_MAX = (1 << 32) - 1
SAFE_INTEGER = (1 << 53) - 1
CHUNK_FRAMES = 8192
STDERR_BYTES = 65536
PROBE_BYTES = 8192
_LOSS_REASONS = frozenset((
    'consumer_failure', 'binding_mismatch', 'observation_timeout',
    'capacity_limited', 'source_unavailable',
))


def _integer(value, maximum=SAFE_INTEGER, minimum=0):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('invalid_integer')
    return value


class AdapterUnavailable(RuntimeError):
    pass


class NoChildCreated(Exception):
    """Trusted factory assertion: it created no child and owns no cleanup.

    Ordinary asyncio exceptions are NEVER translated into this exception.
    Only an injected independently reviewed factory may raise it.
    """


class LifecycleId:
    __slots__ = ()


@dataclass(frozen=True, slots=True)
class DecodedRange:
    lifecycle_id: LifecycleId
    revision: int
    start_frame: int
    end_frame: int
    sample_rate: int


@dataclass(frozen=True, slots=True)
class VerifiedExtentCandidate:
    lifecycle_id: LifecycleId
    revision: int
    total_frames: int
    sample_rate: int


@dataclass(frozen=True, slots=True)
class DecodedPrefixSnapshot:
    lifecycle_id: LifecycleId
    revision: int
    start_frame: int
    end_frame: int
    sample_rate: int
    evidence_valid: bool
    loss_reason: str | None
    terminal_decode_failure: bool
    candidate: VerifiedExtentCandidate | None
    last_range: DecodedRange | None


class _PhysicalOperation:
    def __init__(self, record, function):
        self.record, self.function = record, function
        self.done = False
        self.result = self.error = None
        self.uncertain = False
        self.thread = None


class _WorkerSlot:
    def __init__(self, runner):
        self.event = threading.Event()
        self.operation = None
        self.started = False
        self.thread = threading.Thread(target=runner._worker, args=(self,), daemon=True)


class BoundedPhysicalRunner:
    """Fixed worker slots, no waiting queue and no replacement threads.

    A free slot accepts exactly one operation, not a queue behind an active
    operation. Threads start lazily once per slot and are reused. Uncertain
    Thread.start retains its original slot; there is no replacement worker.
    Construction starts no threads. Only this exact implementation is admitted.
    """
    def __init__(self, limit=8):
        self.limit = _integer(limit, 8, 1)
        self._lock = threading.Lock()
        self._slots = tuple(_WorkerSlot(self) for _ in range(self.limit))
        self._pool = None

    def _register(self, pool):
        with self._lock:
            if self._pool is not None and pool is not self._pool:
                raise AdapterUnavailable('runner_already_composed')
            self._pool = pool

    def try_submit(self, record, function):
        operation = _PhysicalOperation(record, function)
        with self._lock:
            slot = next((slot for slot in self._slots if slot.operation is None), None)
            if slot is None:
                return None
            with record._state:
                if record._physical is not None:
                    raise AdapterUnavailable('physical_operation_busy')
                record._physical = operation
                slot.operation = operation
                operation.thread = slot.thread
                start = not slot.started
                slot.started = True
        slot.event.set()
        if start:
            try:
                slot.thread.start()
            except BaseException as error:
                # No assumption that start raised before doing anything.
                with record._state:
                    if not operation.done:
                        operation.error, operation.uncertain = error, True
                record._notify()
        return operation

    def _worker(self, slot):
        while True:
            slot.event.wait()
            slot.event.clear()
            with self._lock:
                operation = slot.operation
            if operation is None:
                continue
            try:
                result, error = operation.function(), None
            except BaseException as caught:
                result, error = None, caught
            record = operation.record
            with record._state:
                operation.result, operation.error = result, error
                operation.done, operation.uncertain = True, False
                operation.function = None
            with self._lock:
                slot.operation = None
                pool = self._pool
            record._notify()
            if pool is not None:
                try:
                    pool._runner_ready()
                except BaseException:
                    # Readiness notification is not completion/retirement. Keep
                    # the fixed worker alive; explicit record wakes can recover.
                    with record._state:
                        record._loop_unavailable = True


class RootedPlaybackLifecyclePool:
    """Explicit bounded strong owner, including failed and E-held records."""
    def __init__(self, *, physical_runner, limit=8):
        if type(physical_runner) is not BoundedPhysicalRunner:
            raise TypeError('bounded_physical_runner_required')
        self.limit = _integer(limit, 8, 1)
        self.runner = physical_runner
        self._lock = threading.Lock()
        self._records = set()
        self.runner._register(self)

    def admit(self, owner, playback_token):
        loop = asyncio.get_running_loop()
        if type(owner) is not SharedPlaybackSourceOwner or playback_token is not owner._p:
            raise SourceUnavailable('playback_owner_required')
        # State validation only; no check/close/reservation or native work.
        owner._validate_interest(playback_token)
        record = RootedPlaybackAdmission(self, owner, playback_token, loop)
        # Coroutine allocation is known-unowned work: no membership or P
        # transfer exists yet if this allocation fails.
        coroutine = record._drive()
        try:
            with self._lock:
                if len(self._records) >= self.limit:
                    raise AdapterUnavailable('lifecycle_capacity')
                if any(item._owner is owner for item in self._records):
                    raise AdapterUnavailable('owner_already_admitted')
                self._records.add(record)
        except BaseException:
            with self._lock:
                self._records.discard(record)
            coroutine.close()
            raise
        try:
            record._driver = loop.create_task(coroutine)
            record._driver.add_done_callback(record._driver_done)
        except BaseException as error:
            # A custom loop/task factory may have scheduled before raising.
            # Return an accepted, charged failed admission, never a false rollback.
            with record._state:
                record._admitted = True
                record._cancel_requested = record._cleanup_failed = True
                record._task_creation_failed = True
                record._error = error
                record._driver_coroutine = coroutine
            record._notify()
            return record
        # Synchronous, no await: queued driver cannot run before this commit.
        with record._state:
            record._admitted = True
        record._notify()
        return record

    def _runner_ready(self):
        with self._lock:
            records = tuple(self._records)
        for record in records:
            record._notify()

    def _retire(self, record):
        with self._lock:
            self._records.discard(record)

    def request_shutdown(self):
        with self._lock:
            records = tuple(self._records)
        for record in records:
            record.request_cancel()


def _read_up_to(reader, count):
    result = bytearray()
    while len(result) < count:
        fragment = reader.read(count - len(result))
        if not fragment:
            break
        if not isinstance(fragment, bytes) or len(fragment) > count - len(result):
            raise AdapterUnavailable('invalid_reader_result')
        result.extend(fragment)
    return bytes(result)


def _read_header(reader):
    size = reader.seek(0, 2)
    _integer(size)
    reader.seek(0)
    header = _read_up_to(reader, 10)
    offset = 0
    if header[:3] == b'ID3':
        if len(header) != 10 or any(value & 128 for value in header[6:10]):
            return None
        offset = 10 + sum(value << shift for value, shift in zip(header[6:10], (21, 14, 7, 0)))
        if header[3] == 4 and header[5] & 16:
            offset += 10
    if offset + 4 > size:
        return None
    reader.seek(offset)
    return parse_gapless_header(header, _read_up_to(reader, 4096), size, offset)


def parse_gapless_header(header10, frame, size, offset):
    """Bounded pure parser; no media path/cache or identity substitution."""
    if (type(header10) is not bytes or len(header10) > 10
            or type(frame) is not bytes or len(frame) > 4096):
        raise ValueError('invalid_header_buffer')
    _integer(size)
    _integer(offset)
    if offset + 4 > size:
        return None
    word = int.from_bytes(frame[:4], "big")
    version, layer = (word >> 19) & 3, (word >> 17) & 3
    bitrate_index, rate_index = (word >> 12) & 15, (word >> 10) & 3
    if word >> 21 != 0x7ff or version == 1 or layer != 1 or bitrate_index in (0, 15) or rate_index == 3:
        return None
    rate = (44100, 48000, 32000)[rate_index] // (1 if version == 3 else 2 if version == 2 else 4)
    rates = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320) if version == 3 else (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
    frame_size = (144 if version == 3 else 72) * rates[bitrate_index] * 1000 // rate + ((word >> 9) & 1)
    mono = (word >> 6) & 3 == 3
    marker = 4 + (0 if word & (1 << 16) else 2) + ((17 if mono else 32) if version == 3 else (9 if mono else 17))
    if frame_size > len(frame) or frame[marker:marker + 4] not in (b"Xing", b"Info"):
        return None
    flags = int.from_bytes(frame[marker + 4:marker + 8], "big")
    if flags & ~15 or not flags & 1:
        return None
    count = int.from_bytes(frame[marker + 8:marker + 12], "big")
    tag = marker + 8 + sum(length for bit, length in ((1, 4), (2, 4), (4, 100), (8, 4)) if flags & bit)
    if tag + 36 > frame_size or frame[tag:tag + 4].lower() != b"lame" or frame[tag:tag + 4] == b"LAME":
        return None
    if not count or count > (size - offset) // 24:
        return None
    if flags & 2:
        declared_bytes = int.from_bytes(frame[marker + 12:marker + 16], "big")
        if declared_bytes < frame_size or declared_bytes > size - offset:
            return None
    packed = int.from_bytes(frame[tag + 21:tag + 24], "big")
    info = Mp3GaplessInfo(rate, count * (1152 if version == 3 else 576), packed >> 12, packed & 4095)
    # FFmpeg accepts tag CRC mismatches too; bounds, not CRC or silence, define safety.
    return info if info.first_sample < info.end_sample else None


def _unverified_pipe_completion(process):
    # asyncio StreamReader EOF and Process.wait alone are not a reviewed proof
    # that every native pipe transport was closed. Default remains fail-closed.
    return False


class _StdoutOperation:
    """One preallocated identity for read/finish completion and settlement."""
    def __init__(self, record, kind):
        self.record, self.kind = record, kind
        self.task = None
        self.committed = self.completed = False
        self.callback = self._done  # Allocate before reserving credit.
        self.cancel_error = asyncio.CancelledError()

    def _done(self, task):
        record = self.record
        if record is not None:
            record._settle_stdout_operation(self, task)


class RootedPlaybackAdmission:
    """One owner loop and exactly five possible task slots.

    Caller must request_cancel synchronously in finally if admitted start never
    hands back a decoder, including cancellation before the coroutine runs.
    """
    def __init__(self, pool, owner, token, loop):
        self._pool, self._owner, self._token = pool, owner, token
        self._loop, self._thread = loop, threading.get_ident()
        self._state = threading.Lock()
        self._wake = asyncio.Event()
        self._notified = False
        self._admitted = False
        self._loop_unavailable = False
        self._task_creation_failed = False
        self._uncertain_coroutine = None
        self._revision_blocked = False
        self.lifecycle_id = LifecycleId()
        self._driver = self._spawn_task = self._wait_task = None
        self._stdout_task = self._stderr_task = None
        self._physical = None
        self._started = loop.create_future()
        self._finished = loop.create_future()
        # Futures contain results only, not unobserved exception objects.
        self._start_claimed = False
        self._start_claim = None
        self._configured = False
        self._ready = False
        self._cancel_requested = False
        self._decode_failed = False
        self._evidence_invalid = False
        self._candidate_disabled = False
        self._snapshot_stale = False
        self._loss_reason = None
        self._retiring = False
        self._retired = False
        self._cleanup_failed = False
        self._error = None
        self._phase = 'admitted'
        self._owner_status = 'pending'
        self._poll_requested = False
        self._p_release_started = self._p_release_finished = False
        self._child = self._reader = self._pin = self._process = None
        self._parent_reader_closed = True
        self._spawn_invoked = False
        self._proved_no_child = True
        self._child_marked = False
        self._kill_sent = False
        self._stdout_eof = self._stderr_eof = False
        self._stdout_error = self._stderr_error = None
        self._wait_result = None
        self._command = self._capability = None
        self._factory = self._probe = self._pipe_completion = None
        self.gapless = None
        self._stderr_bytes = bytearray()
        self._operation_busy = False
        self._stdout_operation = None
        self._accounting_failed = False
        self._cancel_observing = False
        self._available = self._reserved = 0
        self._reservation_live = False
        self._emitted = self._revision = 0
        self._rate = self._start_frame = None
        self._snapshot = None
        self._candidate = None
        self._last_range = None
        self._eos = False

    def _driver_done(self, task):
        if task is not self._driver or task.cancelled():
            return
        error = task.exception()
        if self._retired and error is None:
            self._pool._retire(self)

    def _require_loop(self):
        if (threading.get_ident() != self._thread
                or asyncio.get_running_loop() is not self._loop):
            raise AdapterUnavailable('foreign_execution_loop')

    def _notify(self):
        with self._state:
            if self._notified or self._retired:
                return
            self._notified = True
        try:
            self._loop.call_soon_threadsafe(self._deliver_wake)
        except BaseException:
            with self._state:
                self._notified = False
                self._loop_unavailable = True
            # Pool retains record/operations; no alternate-loop cleanup.

    def _deliver_wake(self):
        with self._state:
            self._notified = False
            cancel = self._cancel_requested
        if cancel:
            self._signal_child()
        self._wake.set()

    def _signal_child(self):
        # Owner-loop only, no worker waits and no competing pipe reads.
        if self._process is not None and not self._kill_sent:
            self._kill_sent = True
            try:
                self._process.kill()
            except ProcessLookupError:
                pass
            except BaseException as error:
                self._error = self._error or error

    def request_cancel(self):
        with self._state:
            self._cancel_requested = True
            self._invalidate_locked('consumer_failure')
        self._notify()

    def request_disposal_poll(self):
        with self._state:
            if not self._retired and not self._cleanup_failed:
                self._poll_requested = True
        self._notify()

    def _invalidate_locked(self, reason):
        # No allocation is required to make stale good snapshots inaccessible.
        first = not self._evidence_invalid
        self._evidence_invalid = self._candidate_disabled = True
        self._snapshot_stale = True
        if first:
            try:
                self._revision = _integer(self._revision + 1)
            except (MemoryError, ValueError):
                self._revision_blocked = True
        self._candidate = None
        if self._loss_reason is None:
            self._loss_reason = reason

    def mark_observation_lost(self, expected_lifecycle_id, reason):
        if expected_lifecycle_id is not self.lifecycle_id:
            raise AdapterUnavailable('lifecycle_identity_mismatch')
        if reason not in _LOSS_REASONS:
            raise ValueError('invalid_observation_loss')
        with self._state:
            self._invalidate_locked(reason)

    def observation_snapshot(self, expected_lifecycle_id):
        if expected_lifecycle_id is not self.lifecycle_id:
            raise AdapterUnavailable('lifecycle_identity_mismatch')
        with self._state:
            if not self._ready:
                raise AdapterUnavailable('observation_not_ready')
            if self._revision_blocked:
                raise AdapterUnavailable('observation_unavailable')
            if self._snapshot_stale:
                try:
                    snapshot = self._make_snapshot_locked(None, None)
                except MemoryError:
                    self._invalidate_locked('capacity_limited')
                    raise AdapterUnavailable('observation_unavailable') from None
                self._snapshot = snapshot
                self._snapshot_stale = False
            return self._snapshot

    def _make_snapshot_locked(self, last_range, candidate):
        return DecodedPrefixSnapshot(
            self.lifecycle_id, self._revision, self._start_frame,
            self._start_frame + self._emitted, self._rate,
            not self._evidence_invalid, self._loss_reason,
            self._decode_failed, candidate, last_range,
        )

    def _claim_start(self, command, *, capability,
                    process_factory=asyncio.create_subprocess_exec,
                    capability_probe=DEFAULT_SOURCE_CAPABILITY_PROBE,
                    pipe_completion=_unverified_pipe_completion):
        self._require_loop()
        _integer(command.sample_rate, UINT32_MAX, 1)
        _integer(command.start_frame)
        _integer(command.generation, UINT32_MAX, 1)
        _integer(command.stream_id, UINT32_MAX, 1)
        if command.path.suffix.lower() != self._owner._source.original_suffix:
            raise AdapterUnavailable('source_suffix_changed')
        if self._owner._source.backend.platform != 'posix':
            raise AdapterUnavailable('retained_platform_unaccepted')
        if (not callable(process_factory) or not callable(pipe_completion)
                or not callable(getattr(capability_probe, 'matches', None))):
            raise TypeError('invalid_process_contract')
        claim = object()  # This invocation's identity, never the shared bool.
        with self._state:
            if self._cancel_requested or self._start_claimed:
                raise AdapterUnavailable('start_unavailable')
            self._start_claim = claim
            self._start_claimed = True
            self._command, self._capability = command, capability
            self._factory, self._probe = process_factory, capability_probe
            self._pipe_completion = pipe_completion
            self._rate, self._start_frame = command.sample_rate, command.start_frame
            self._configured = True
        self._notify()
        return claim

    def _cancel_start(self, claim):
        with self._state:
            owned = claim is not None and claim is self._start_claim
        if owned:
            self.request_cancel()

    async def _await_start(self, claim):
        self._require_loop()
        with self._state:
            if claim is None or claim is not self._start_claim:
                raise AdapterUnavailable('start_claim_invalid')
        try:
            error = await asyncio.shield(self._started)
            if error is not None:
                raise error
        except BaseException:
            self._cancel_start(claim)
            raise

    async def start(self, command, *, capability,
                    process_factory=asyncio.create_subprocess_exec,
                    capability_probe=DEFAULT_SOURCE_CAPABILITY_PROBE,
                    pipe_completion=_unverified_pipe_completion):
        claim = self._claim_start(command, capability=capability,
            process_factory=process_factory, capability_probe=capability_probe,
            pipe_completion=pipe_completion)
        try:
            await self._await_start(claim)
        except BaseException:
            self._cancel_start(claim)
            raise

    async def _physical_call(self, function):
        # Only the driver or the one stdout owner may submit physical work;
        # cleanup waits for that stdout owner before doing physical operations.
        operation = None
        while operation is None:
            self._wake.clear()
            with self._state:
                if self._physical is not None:
                    raise AdapterUnavailable('physical_operation_busy')
            operation = self._pool.runner.try_submit(self, function)
            if operation is None:
                await self._wake.wait()  # readiness event, never a work queue
        while True:
            self._wake.clear()
            with self._state:
                done, uncertain = operation.done, operation.uncertain
                if done:
                    result, error = operation.result, operation.error
                    self._physical = None
                    operation.record = None
                    break
            if uncertain:
                self._cleanup_failed = True
                raise AdapterUnavailable('physical_submission_uncertain')
            await self._wake.wait()
        if error is not None:
            raise error
        return result

    def _checked(self):
        pin = self._owner.pin_playback(self._token)
        self._pin = pin
        try:
            return pin.check()
        finally:
            pin.release()
            self._pin = None

    def _capability_matches(self):
        cap = self._capability
        if (not cap.available or cap.identity is None or cap.protocol != 'fd'
                or not self._probe.matches(cap)):
            raise AdapterUnavailable('capability_unavailable')

    def _inspect(self):
        if self._owner._source.original_suffix != '.mp3':
            return None
        pin = self._owner.pin_playback(self._token)
        self._pin = pin
        try:
            pin.check()
            self._reader = pin.reader()
            self._parent_reader_closed = False
            result = _read_header(self._reader)
            pin.check()
            return result
        finally:
            if self._reader is not None:
                # Set attempted before close; no retry if it raises.
                reader, self._reader = self._reader, None
                try:
                    reader.close()
                    self._parent_reader_closed = True
                except BaseException:
                    self._cleanup_failed = True
                    raise
            pin.release()
            self._pin = None

    def _prepare(self):
        self._capability_matches()
        self._child = self._owner.begin_child(self._token)
        self._proved_no_child = True
        self._spawn_invoked = self._child_marked = False
        pin = self._owner.pin_playback(self._token)
        self._pin = pin
        try:
            self._reader = pin.reader()
            self._parent_reader_closed = False
            backend = self._owner._source.backend
            value = backend.value(self._reader)
            options = backend.inheritance(self._reader)
            if (type(value) is not int or value < 0
                    or options != {'pass_fds': (value,), 'close_fds': True}):
                raise AdapterUnavailable('invalid_descriptor_transport')
            pin.check()
            self._capability_matches()
            return value, options
        finally:
            pin.release()
            self._pin = None

    def _close_parent(self):
        if self._reader is not None:
            reader, self._reader = self._reader, None
            try:
                reader.close()
                self._parent_reader_closed = True
            except BaseException:
                self._cleanup_failed = True
                raise

    def _postspawn(self):
        self._child.mark_launched()
        self._child_marked = True
        self._close_parent()
        self._checked()
        self._capability_matches()

    async def _spawn(self, value, options, before, after):
        # Store the process in the charged record before any later await or
        # wrapper allocation. Shielding prevents caller cancellation of factory.
        self._spawn_invoked = True
        self._proved_no_child = False
        try:
            process = await self._factory(
                self._capability.identity.path, '-nostdin', *before,
                '-fd', str(value), '-i', 'fd:', *after,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                creationflags=hidden_subprocess_creation_flags(), **options,
            )
        except NoChildCreated:
            self._proved_no_child = True
            raise
        self._process = process
        return process

    def _new_task(self, slot, coroutine, *, operation=None):
        previous = getattr(self, slot)
        if previous is not None and not previous.done():
            coroutine.close()
            raise AdapterUnavailable('task_slot_busy')
        try:
            task = self._loop.create_task(coroutine)
            setattr(self, slot, task)
            if operation is not None:
                operation.task = task
                # Eager factories may return an already-completed Task. The
                # awaiting path settles it synchronously; do not accumulate
                # scheduled callbacks behind a run of eager synchronous reads.
                if not task.done():
                    task.add_done_callback(operation.callback)
        except BaseException:
            # A task factory can schedule before raising; do not close/retry it.
            self._uncertain_coroutine = coroutine
            self._task_creation_failed = self._cleanup_failed = True
            raise
        return task

    async def _launch(self, before, after):
        with self._state:
            if self._cancel_requested:
                raise asyncio.CancelledError
        value, options = await self._physical_call(self._prepare)
        with self._state:
            if self._cancel_requested:
                raise asyncio.CancelledError
        spawn = self._new_task('_spawn_task', self._spawn(value, options, before, after))
        await asyncio.shield(spawn)
        # This nonblocking publication makes cancellation able to signal child
        # even while the following physical operation is still in progress.
        with self._state:
            cancel = self._cancel_requested
        if cancel:
            self._signal_child()
        self._new_task('_wait_task', self._wait_child())
        if self._process.stderr is not None:
            self._new_task('_stderr_task', self._drain_stderr())
        await self._physical_call(self._postspawn)
        if self._process.stdout is None or self._process.stderr is None:
            raise AdapterUnavailable('missing_process_pipe')
        with self._state:
            if self._cancel_requested:
                raise asyncio.CancelledError

    async def _wait_child(self):
        result = await self._process.wait()
        if type(result) is not int:
            raise AdapterUnavailable('invalid_wait_result')
        self._wait_result = result
        return result

    async def _drain_stderr(self):
        try:
            while True:
                chunk = await self._process.stderr.read(8192)
                if not chunk:
                    self._stderr_eof = True
                    return
                if type(chunk) is not bytes or len(chunk) > 8192:
                    raise AdapterUnavailable('invalid_stderr_read')
                self._stderr_bytes.extend(chunk)
                if len(self._stderr_bytes) > STDERR_BYTES:
                    del self._stderr_bytes[:-STDERR_BYTES]
        except BaseException as error:
            self._stderr_error = error
            raise

    async def _probe_output(self):
        output = bytearray()
        try:
            while len(output) <= PROBE_BYTES:
                chunk = await self._process.stdout.read(min(8192, PROBE_BYTES + 1 - len(output)))
                if not chunk:
                    self._stdout_eof = True
                    return bytes(output)
                if type(chunk) is not bytes or len(chunk) > min(8192, PROBE_BYTES + 1 - len(output)):
                    raise AdapterUnavailable('invalid_probe_read')
                output.extend(chunk)
            raise AdapterUnavailable('probe_output_limit')
        except BaseException as error:
            self._stdout_error = error
            raise

    async def _discard_stdout(self):
        try:
            while True:
                chunk = await self._process.stdout.read(8192)
                if not chunk:
                    break
                if type(chunk) is not bytes or len(chunk) > 8192:
                    raise AdapterUnavailable('invalid_discard_read')
            self._stdout_eof = True
        except BaseException as error:
            self._stdout_error = error
            raise

    async def _await_task(self, task, timeout=None):
        # asyncio.wait receives an existing Task; no implicit sixth task.
        if task is None:
            return None
        if timeout is None:
            return await asyncio.shield(task)
        done, _ = await asyncio.wait((task,), timeout=timeout)
        if not done:
            raise TimeoutError('owned_operation_pending')
        return task.result()

    def _settle_child(self):
        if not self._parent_reader_closed or self._pin is not None:
            raise AdapterUnavailable('physical_cleanup_unproven')
        if self._child is None:
            return
        if self._process is None:
            if not self._proved_no_child:
                raise AdapterUnavailable('spawn_outcome_uncertain')
            self._child.release_no_child(proved_no_child=True, cleanup_complete=True)
        else:
            if not self._child_marked:
                self._child.mark_launched()
                self._child_marked = True
            if (type(self._wait_result) is not int
                    or self._pipe_completion(self._process) is not True):
                raise AdapterUnavailable('pipe_cleanup_unproven')
            self._child.release_after_reap(wait_result=self._wait_result, cleanup_complete=True)
        self._child = None

    def _reset_child(self):
        # Only after exact child settlement, never around cleanup uncertainty.
        self._process = None
        self._spawn_task = self._wait_task = None
        self._stdout_task = self._stderr_task = None
        self._wait_result = None
        self._kill_sent = False
        self._stdout_eof = self._stderr_eof = False
        self._stdout_error = self._stderr_error = None
        self._stderr_bytes.clear()

    async def _run_probe(self, info):
        await self._launch(('-hide_banner', '-loglevel', 'error'), (
            '-map', '0:a:0', '-c:a', 'copy', '-frames:a', '1', '-f', 'framecrc', 'pipe:1',
        ))
        deadline = self._loop.time() + 5.0
        stdout = self._new_task('_stdout_task', self._probe_output())
        output = await self._await_task(stdout, max(0, deadline - self._loop.time()))
        result = await self._await_task(self._wait_task, max(0, deadline - self._loop.time()))
        await self._await_task(self._stderr_task, max(0, deadline - self._loop.time()))
        if result != 0 or b'#codec_id 0: mp3' not in output:
            raise AdapterUnavailable('gapless_probe_failed')
        await self._physical_call(self._checked)
        await self._physical_call(self._capability_matches)
        await self._physical_call(self._settle_child)
        self._reset_child()
        return None if b'Skip Samples' in output else info

    def _decoder_arguments(self):
        command = self._command
        seconds = command.start_frame / command.sample_rate
        output = ()
        if self._owner._source.original_suffix in {'.wav', '.wave', '.flac', '.aif', '.aiff'}:
            before = ('-ss', f'{seconds:.9f}')
        else:
            coarse = max(0.0, seconds - .25)
            before = ('-ss', f'{coarse:.9f}')
            output = ('-ss', f'{seconds - coarse:.9f}')
        filters = ()
        if self.gapless is not None:
            coarse, expression = self.gapless.decode_filters(command.sample_rate, command.start_frame)
            before = ('-ss', str(coarse)) if coarse else ()
            output, filters = (), ('-af', expression)
        return (('-hide_banner', '-loglevel', 'error', *before),
                (*output, '-vn', *filters, '-f', 'f32le', '-acodec', 'pcm_f32le',
                 '-ac', '2', '-ar', str(command.sample_rate), 'pipe:1'))

    async def _drive(self):
        try:
            # An eager/custom task factory may run this body before admit's
            # synchronous transfer commit. Provisional records do no work.
            while True:
                self._wake.clear()
                with self._state:
                    admitted = self._admitted
                if admitted:
                    break
                await self._wake.wait()
            while True:
                self._wake.clear()
                with self._state:
                    cancel, configured = self._cancel_requested, self._configured
                if cancel:
                    break
                if configured:
                    self._phase = 'inspecting'
                    info = await self._physical_call(self._inspect)
                    if info is not None:
                        self._phase = 'probe'
                        self.gapless = await self._run_probe(info)
                    self._phase = 'decoder_launching'
                    before, after = self._decoder_arguments()
                    await self._launch(before, after)
                    with self._state:
                        if self._cancel_requested:
                            raise asyncio.CancelledError
                        try:
                            self._snapshot = self._make_snapshot_locked(None, None)
                        except MemoryError:
                            self._invalidate_locked('capacity_limited')
                        self._ready = True
                    self._phase = 'decoding'
                    self._started.set_result(None)
                    break
                await self._wake.wait()
            while self._ready:
                self._wake.clear()
                with self._state:
                    stop = self._cancel_requested or self._retiring
                if stop:
                    break
                await self._wake.wait()
        except BaseException as error:
            self._error = error
            with self._state:
                self._cancel_requested = True
                self._invalidate_locked('source_unavailable')
        finally:
            if not self._started.done():
                self._started.set_result(self._error or AdapterUnavailable('start_cancelled'))
        try:
            self._phase = 'cleanup'
            await self._cleanup()
            await self._release_and_poll()
        except BaseException as error:
            self._error = self._error or error
            self._cleanup_failed = True
            self._phase = 'cleanup_failed'
        finally:
            if not self._finished.done():
                self._finished.set_result(self._error)

    async def _cleanup(self):
        with self._state:
            cancel = self._cancel_requested
        if cancel:
            self._signal_child()
        if self._task_creation_failed or self._accounting_failed:
            raise AdapterUnavailable('task_or_accounting_uncertain')
        # Spawn task is never cancelled. If the loop itself cancelled the driver,
        # unresolved spawn remains charged rather than pretending no child.
        if self._spawn_task is not None:
            try:
                await self._await_task(self._spawn_task)
            except NoChildCreated:
                pass
            except BaseException:
                if self._process is None and not self._proved_no_child:
                    raise AdapterUnavailable('spawn_outcome_uncertain') from None
        if self._process is not None:
            if cancel:
                self._signal_child()
            if self._wait_task is None:
                self._new_task('_wait_task', self._wait_child())
            if self._stderr_task is None and self._process.stderr is not None:
                self._new_task('_stderr_task', self._drain_stderr())
            # Reap and stderr already progress independently if stdout stalls.
            if self._stdout_task is not None:
                try:
                    await self._await_task(self._stdout_task)
                except BaseException as error:
                    # Logical read cancellation is not itself a transport leak.
                    # Actual failed-pipe completion still needs the explicit
                    # contract below, after all owners have finished.
                    self._error = self._error or error
            operation = self._stdout_operation
            if operation is not None and operation.task is self._stdout_task:
                self._settle_stdout_operation(operation, self._stdout_task)
            if self._accounting_failed:
                raise AdapterUnavailable('read_accounting_uncertain')
            if not self._stdout_eof and self._process.stdout is not None:
                self._new_task('_stdout_task', self._discard_stdout())
            errors = []  # At most three fixed owners, never an accumulated log.
            for task in (self._stdout_task, self._stderr_task, self._wait_task):
                try:
                    await self._await_task(task)
                except BaseException as error:
                    errors.append(error)
            # Even pipe failures did not bypass the independent wait owner.
            if errors:
                self._error = self._error or errors[0]
        await self._physical_call(self._close_parent)
        if self._cleanup_failed or self._pin is not None:
            raise AdapterUnavailable('physical_cleanup_failed')
        await self._physical_call(self._settle_child)

    def _release_p(self):
        self._p_release_started = True
        self._owner.release_playback(self._token)
        self._p_release_finished = True
        return self._owner.try_close()

    async def _release_and_poll(self):
        status = await self._physical_call(self._release_p)
        while True:
            self._owner_status = status
            if status == 'disposed':
                with self._state:
                    self._retired = True
                self._phase = 'disposed'
                # Membership retires in _driver_done, after this last task
                # has actually completed, never one instruction before it.
                return
            if status == 'cleanup_failed':
                raise AdapterUnavailable('source_cleanup_failed')
            self._phase = 'retained_pending'
            while True:
                self._wake.clear()
                with self._state:
                    poll = self._poll_requested
                    self._poll_requested = False
                if poll:
                    break
                await self._wake.wait()
            status = await self._physical_call(self._owner.try_close)

    @property
    def emitted_frames(self):
        with self._state:
            return self._emitted

    @property
    def outstanding_credit_frames(self):
        with self._state:
            return self._available

    @property
    def stderr_tail(self):
        return bytes(self._stderr_bytes).decode(errors='replace')

    def grant_credit(self, frames):
        self._require_loop()
        _integer(frames, UINT32_MAX)
        with self._state:
            if self._cancel_requested or self._decode_failed or self._eos:
                raise AdapterUnavailable('decoder_not_readable')
            new_credit = self._available + self._reserved + frames
            if new_credit > UINT32_MAX:
                raise AdapterUnavailable('credit_capacity')
            self._available += frames

    def _claim_operation(self, kind):
        operation = _StdoutOperation(self, kind)
        with self._state:
            if (not self._ready or self._cancel_requested or self._decode_failed
                    or self._operation_busy):
                raise AdapterUnavailable('decoder_operation_unavailable')
            self._operation_busy = True
            self._stdout_operation = operation
        return operation

    def _release_unstarted_operation(self, operation):
        with self._state:
            if (operation is self._stdout_operation and operation.task is None
                    and not self._reservation_live and not self._task_creation_failed):
                operation.completed = True
                operation.record = operation.callback = None
                self._stdout_operation = None
                self._operation_busy = False

    def _settle_stdout_operation(self, operation, task):
        # Called by the registered done callback AND by awaiting/cleanup paths.
        # All paths use the same identity and one-shot reservation state. Never
        # settle a still-running shielded owner or a predecessor's new read.
        if task is None or not task.done():
            return
        with self._state:
            if (operation.completed or operation is not self._stdout_operation
                    or task is not operation.task):
                return
        error = operation.cancel_error if task.cancelled() else task.exception()
        if error is not None:
            try:
                self._fail_read(error)
            except BaseException as accounting_error:
                with self._state:
                    self._accounting_failed = self._cleanup_failed = True
                    self._error = self._error or accounting_error
                self._notify()
                return
        with self._state:
            if self._reservation_live:
                # A supposedly successful task without mandatory settlement is
                # not proof of returned PCM; retain accountable failure.
                self._accounting_failed = self._cleanup_failed = True
                self._decode_failed = self._cancel_requested = True
                self._invalidate_locked('source_unavailable')
            else:
                operation.completed = True
                operation.record = operation.callback = None
                self._stdout_operation = None
                self._operation_busy = False
        self._notify()

    def _fail_read(self, error):
        with self._state:
            self._decode_failed = self._cancel_requested = True
            self._invalidate_locked('source_unavailable')
            # The original reservation remains part of the cap until this
            # exactly-once settlement, including grants received during await.
            if self._reservation_live:
                refunded = self._available + self._reserved
                self._available, self._reserved = refunded, 0
                self._reservation_live = False
            self._error = self._error or error
        self._notify()

    async def read_credited_frames(self, *, max_frames, delivery_role=None, chunk_factory):
        self._require_loop()
        _integer(max_frames, UINT32_MAX)
        if delivery_role not in (None, 'current', 'continuity'):
            raise ValueError('invalid_delivery_role')
        operation = self._claim_operation('read')
        task = None
        try:
            with self._state:
                if self._eos:
                    return chunk_factory(frame_count=0, pcm=b'')
                reservation = min(max_frames, self._available, CHUNK_FRAMES)
                if reservation == 0:
                    return chunk_factory(frame_count=0, pcm=b'')
                new_available = self._available - reservation
                self._available = new_available
                self._reserved = reservation
                self._reservation_live = True
            try:
                task = self._new_task('_stdout_task', self._read_output(
                    reservation, delivery_role, chunk_factory, operation),
                    operation=operation)
            except BaseException as error:
                if not self._task_creation_failed:
                    self._fail_read(error)  # Known coroutine-allocation failure.
                else:
                    # Unknown scheduled ownership keeps reservation until its
                    # actual task settles. Do not refund a possibly live reader.
                    with self._state:
                        self._decode_failed = self._cancel_requested = True
                        self._invalidate_locked('source_unavailable')
                    self._notify()
                raise
            try:
                return await asyncio.shield(task)
            except BaseException:
                self.request_cancel()
                self._settle_stdout_operation(operation, task)
                raise
        finally:
            if operation.task is not None:
                self._settle_stdout_operation(operation, operation.task)
            else:
                self._release_unstarted_operation(operation)

    async def _read_output(self, reservation, delivery_role, chunk_factory, operation):
        try:
            count = reservation * 8
            first = await self._process.stdout.read(count)
            if type(first) is not bytes or len(first) > count:
                raise AdapterUnavailable('invalid_pcm_read_size')
            data = bytearray(first)
            if not data:
                self._stdout_eof = True
                await self._complete_eos()
            elif (self._command.role if delivery_role is None else delivery_role) == 'continuity':
                while len(data) < count:
                    fragment = await self._process.stdout.read(count - len(data))
                    if not fragment:
                        self._stdout_eof = True
                        break
                    if type(fragment) is not bytes or len(fragment) > count - len(data):
                        raise AdapterUnavailable('invalid_pcm_read_size')
                    data.extend(fragment)
            while len(data) % 8:
                extra = await self._process.stdout.read(8 - len(data) % 8)
                if not extra:
                    self._stdout_eof = True
                    raise AdapterUnavailable('partial_pcm_frame')
                if type(extra) is not bytes or len(extra) > 8 - len(data) % 8:
                    raise AdapterUnavailable('invalid_pcm_read_size')
                data.extend(extra)
            if len(data) > count:
                raise AdapterUnavailable('invalid_pcm_read_size')
            frame_count = len(data) // 8
            result = chunk_factory(frame_count=frame_count, pcm=bytes(data))
            with self._state:
                # Mandatory scalar allocations happen before optional evidence.
                emitted = _integer(self._emitted + frame_count)
                end = _integer(self._start_frame + emitted)
                revision = _integer(self._revision + int(bool(frame_count)))
                available = self._available + reservation - frame_count
                if self._cancel_requested or self._decode_failed:
                    raise asyncio.CancelledError
                last_range, snapshot = None, None
                try:
                    if frame_count:
                        last_range = DecodedRange(self.lifecycle_id, revision,
                            self._start_frame + self._emitted, end, self._rate)
                    snapshot = DecodedPrefixSnapshot(
                        self.lifecycle_id, revision, self._start_frame, end, self._rate,
                        not self._evidence_invalid, self._loss_reason, False,
                        None if self._candidate_disabled else self._candidate,
                        last_range if frame_count else self._last_range,
                    )
                except MemoryError:
                    self._invalidate_locked('capacity_limited')
                self._available, self._reserved = available, 0
                self._reservation_live = False
                operation.committed = True
                self._emitted = emitted
                self._revision = max(self._revision, revision)
                if snapshot is not None:
                    self._snapshot = snapshot
                    self._snapshot_stale = False
                    if frame_count:
                        self._last_range = last_range
            return result
        except BaseException as error:
            self._fail_read(error)
            raise
        finally:
            self._notify()  # Claim release belongs to actual task completion.

    async def finish(self):
        self._require_loop()
        operation = self._claim_operation('finish')
        task = None
        try:
            if not self._process.stdout.at_eof():
                raise AdapterUnavailable('finish_before_stdout_eof')
            try:
                task = self._new_task('_stdout_task', self._finish_output(operation),
                    operation=operation)
            except BaseException as error:
                if not self._task_creation_failed:
                    self._fail_read(error)
                else:
                    with self._state:
                        self._decode_failed = self._cancel_requested = True
                        self._invalidate_locked('source_unavailable')
                    self._notify()
                raise
            try:
                await asyncio.shield(task)
            except BaseException:
                self.request_cancel()
                self._settle_stdout_operation(operation, task)
                raise
        finally:
            if operation.task is not None:
                self._settle_stdout_operation(operation, operation.task)
            else:
                self._release_unstarted_operation(operation)

    async def _finish_output(self, operation):
        try:
            self._stdout_eof = True
            await self._complete_eos()
            with self._state:
                operation.committed = True
        except BaseException as error:
            self._fail_read(error)
            raise
        finally:
            self._notify()  # Includes cancellation before body's first step via callback.

    async def _complete_eos(self):
        if self._eos:
            return
        result = await self._await_task(self._wait_task)
        await self._await_task(self._stderr_task)
        if result != 0:
            raise AdapterUnavailable('decoder_nonzero_exit')
        await self._physical_call(self._checked)
        with self._state:
            if self._cancel_requested or self._decode_failed:
                raise asyncio.CancelledError
            candidate, snapshot = None, None
            try:
                if self._start_frame == 0 and not self._candidate_disabled:
                    candidate = VerifiedExtentCandidate(
                        self.lifecycle_id, self._revision, self._emitted, self._rate)
                snapshot = self._make_snapshot_locked(self._last_range, candidate)
            except MemoryError:
                self._invalidate_locked('capacity_limited')
            if snapshot is not None:
                self._snapshot = snapshot
                self._snapshot_stale = False
                self._candidate = candidate
            self._eos = True
            self._retiring = True
        self._notify()

    async def cancel(self):
        self._require_loop()
        self.request_cancel()
        with self._state:
            if self._cancel_observing:
                raise AdapterUnavailable('cleanup_observer_busy')
            self._cancel_observing = True
        try:
            # Exactly one observer owns a bounded waiter/timer. Other callers
            # publish the coalesced cancel flag but install no observation state.
            done, _ = await asyncio.wait((self._finished,), timeout=2.0)
            if not done:
                raise AdapterUnavailable('cleanup_pending')
            error = self._finished.result()
            if error is not None:
                raise AdapterUnavailable('cleanup_incomplete') from error
        finally:
            with self._state:
                self._cancel_observing = False
