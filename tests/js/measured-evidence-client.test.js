const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/measured_evidence_client_vectors.json'), 'utf8'));
const load = () => import(pathToFileURL(path.join(__dirname, '../../music_app/static/js/telemetry/measured-evidence.mjs')).href);
const binding = vectors.binding;
const otherId = n => `${n.toString(16).padStart(8, '0')}-4444-4444-8444-444444444444`;
function receipt(pending, changes = {}) {
  return JSON.stringify({ ok: true, decoder_instance_id: pending.decoder_instance_id,
    device_id: pending.checkpoint.device_id, session_id: pending.checkpoint.session_id,
    checkpoint_sequence: pending.checkpoint.checkpoint_sequence, digest: 'a'.repeat(64),
    finalized: pending.checkpoint.finalized, ...changes });
}
for (const vector of vectors.cases) test(`shared Python parity: ${vector.name}`, async () => {
  const { EvidenceAccumulator, VERSION, canonicalCheckpoint } = await load();
  const accumulator = new EvidenceAccumulator(binding); let consumed = 0;
  vector.checkpoints.forEach((expected, sequence) => {
    while (consumed < expected.after) accumulator.consume(vector.events[consumed++]);
    const { after, ...fields } = expected;
    const checkpoint = accumulator.snapshot(sequence);
    const wanted = { version: VERSION, device_id: binding.device_id, session_id: binding.session_id,
      sample_rate: 8000, checkpoint_sequence: sequence, coverage_complete: true,
      instrumentation_complete: true, finalized: false, ...fields };
    assert.deepEqual(checkpoint, wanted);
    assert.deepEqual(JSON.parse(canonicalCheckpoint(checkpoint)), wanted);
    assert.equal(checkpoint.histogram.reduce((sum, [, weight]) => sum + weight, 0), checkpoint.rendered_frames);
  });
});
test('adjacent intervals merge; repetition adds weight without new unique coverage', async () => {
  const { EvidenceAccumulator } = await load(); const a = new EvidenceAccumulator(binding);
  a.consume({ event_index: 0, start_frame: 4, frames: 4 });
  a.consume({ event_index: 1, start_frame: 0, frames: 4 });
  a.consume({ event_index: 2, start_frame: 0, frames: 8 });
  assert.deepEqual(a.snapshot(0).coverage_intervals, [[0, 8]]);
  assert.deepEqual(a.snapshot(0).histogram, [[0, 16]]);
});
test('4097th disjoint interval preserves every prior lower bound and becomes sticky limited', async () => {
  const { EvidenceAccumulator, LIMITS } = await load(); const a = new EvidenceAccumulator(binding);
  for (let i = 0; i < LIMITS.intervals; i++) a.consume({ event_index: i, start_frame: 2 * i, frames: 1 });
  const old = a.snapshot(0);
  a.consume({ event_index: LIMITS.intervals, start_frame: 2 * LIMITS.intervals, frames: 1 });
  assert.deepEqual(a.snapshot(1).coverage_intervals, old.coverage_intervals);
  assert.equal(a.snapshot(1).coverage_complete, false);
  assert.equal(a.snapshot(1).rendered_frames, 4097);
  a.consume({ event_index: LIMITS.intervals + 1, start_frame: 0, frames: 1 });
  assert.equal(a.snapshot(2).coverage_complete, false);
});
test('duplicate last event is idempotent, conflicting/gapped event halts without recounting', async () => {
  const { EvidenceAccumulator } = await load(); const a = new EvidenceAccumulator(binding);
  const event = { event_index: 0, start_frame: 0, frames: 2 };
  assert.equal(a.consume(event), true); assert.equal(a.consume(event), false);
  assert.throws(() => a.consume({ ...event, frames: 3 }), /event_order_conflict/);
  assert.equal(a.snapshot(0).rendered_frames, 2);
  assert.equal(a.snapshot(0).instrumentation_complete, false);
  assert.throws(() => a.consume({ event_index: 1, start_frame: 2, frames: 1 }), /instance_closed/);
});
test('unsafe/malformed input cannot mutate a valid accumulator', async () => {
  const { EvidenceAccumulator } = await load(); const a = new EvidenceAccumulator(binding);
  for (const event of [{ event_index: 0, start_frame: -1, frames: 1 },
    { event_index: 0, start_frame: Number.MAX_SAFE_INTEGER, frames: 1 },
    { event_index: false, start_frame: 0, frames: 1 }, { event_index: 0, start_frame: 0, frames: 0 }]) {
    assert.throws(() => a.consume(event), /invalid_integer/);
  }
  assert.equal(a.snapshot(0).rendered_frames, 0);
  assert.throws(() => new EvidenceAccumulator({ ...binding, sample_rate: 0 }), /invalid_integer/);
  assert.throws(() => new EvidenceAccumulator({ ...binding, total_frames: 9000 }), /invalid_identity/);
});
test('seek retains immutable pending bytes while promotion reuses its owner', async () => {
  const { PendingEvidenceOwner } = await load(); const owner = new PendingEvidenceOwner();
  const a = owner.open(binding); a.consume({ event_index: 0, start_frame: 0, frames: 4 });
  const pending = owner.prepare(binding.decoder_instance_id), original = pending.body;
  a.consume({ event_index: 1, start_frame: 4, frames: 4 });
  assert.strictEqual(owner.prepare(binding.decoder_instance_id), pending);
  assert.equal(pending.body, original); assert.equal(pending.checkpoint.rendered_frames, 4);
  assert.strictEqual(owner.open({ ...binding }), a); // promotion does not reset.
  const second = { ...binding, decoder_instance_id: otherId(1) };
  owner.open(second).consume({ event_index: 0, start_frame: 100, frames: 2 });
  assert.equal(owner.prepare(second.decoder_instance_id).checkpoint.checkpoint_sequence, 0);
  assert.equal(owner.pending(binding.decoder_instance_id).body, original);
  assert(Object.isFrozen(pending.checkpoint.histogram[0]));
  const body = receipt(pending); owner.acknowledge(binding.decoder_instance_id, original, 200, body);
  assert.equal(owner.receipt(binding.decoder_instance_id).body, body);
  const next = owner.prepare(binding.decoder_instance_id);
  assert.equal(next.checkpoint.checkpoint_sequence, 1); assert.equal(next.checkpoint.rendered_frames, 8);
});
test('receipt mismatch and conflict preserve exact pending state and prior receipt', async () => {
  const { PendingEvidenceOwner } = await load(); const owner = new PendingEvidenceOwner(); owner.open(binding);
  const pending = owner.prepare(binding.decoder_instance_id);
  for (const changes of [{ checkpoint_sequence: 1 }, { decoder_instance_id: otherId(2) }, { finalized: true }, { digest: 'bad' }]) {
    assert.throws(() => owner.acknowledge(binding.decoder_instance_id, pending.body, 200, receipt(pending, changes)), /invalid_receipt/);
  }
  assert.throws(() => owner.acknowledge(binding.decoder_instance_id, pending.body + ' ', 200, receipt(pending)), /pending_mismatch/);
  owner.block(binding.decoder_instance_id);
  assert.throws(() => owner.prepare(binding.decoder_instance_id), /reconciliation_required/);
  assert.strictEqual(owner.pending(binding.decoder_instance_id), pending);
  assert.equal(owner.receipt(binding.decoder_instance_id), null);
});
test('final snapshot waits behind unresolved bytes then cannot advance after final receipt', async () => {
  const { PendingEvidenceOwner } = await load(); const owner = new PendingEvidenceOwner(); const a = owner.open(binding);
  const initial = owner.prepare(binding.decoder_instance_id); owner.finalize(binding.decoder_instance_id);
  assert.strictEqual(owner.prepare(binding.decoder_instance_id), initial);
  owner.acknowledge(binding.decoder_instance_id, initial.body, 200, receipt(initial));
  const final = owner.prepare(binding.decoder_instance_id); assert.equal(final.checkpoint.finalized, true);
  owner.acknowledge(binding.decoder_instance_id, final.body, 200, receipt(final));
  assert.throws(() => owner.prepare(binding.decoder_instance_id), /already_finalized/);
  assert.throws(() => a.consume({ event_index: 0, start_frame: 0, frames: 1 }), /instance_closed/);
});
test('session/page caps reject without evicting earlier instances or mixing tracks', async () => {
  const { PendingEvidenceOwner, LIMITS } = await load(); const owner = new PendingEvidenceOwner();
  const a = owner.open(binding); const pending = owner.prepare(binding.decoder_instance_id);
  assert.throws(() => owner.open({ ...binding, decoder_instance_id: otherId(500), track_id: 999 }), /logical_track_conflict/);
  for (let i = 1; i < LIMITS.instancesPerSession; i++) owner.open({ ...binding, decoder_instance_id: otherId(i) });
  assert.throws(() => owner.open({ ...binding, decoder_instance_id: otherId(500) }), /session_instance_limit/);
  for (let i = 128; i < LIMITS.instancesPerPage; i++) owner.open({ ...binding, decoder_instance_id: otherId(i), session_id: otherId(1000) });
  assert.throws(() => owner.open({ ...binding, decoder_instance_id: otherId(500), session_id: otherId(1001) }), /page_instance_limit/);
  assert.strictEqual(owner.open(binding), a); assert.strictEqual(owner.pending(binding.decoder_instance_id), pending);
  assert.throws(() => owner.open({ ...binding, sample_rate: 16000 }), /identity_conflict/);
});
test('pending-byte and checkpoint-body limits refuse atomically; acknowledgement releases bytes', async () => {
  const { PendingEvidenceOwner, LIMITS } = await load();
  const sample = new PendingEvidenceOwner(); sample.open(binding);
  const size = sample.prepare(binding.decoder_instance_id).body.length;
  const owner = new PendingEvidenceOwner({ pendingBytes: size }); owner.open(binding);
  const pending = owner.prepare(binding.decoder_instance_id);
  const nextBinding = { ...binding, decoder_instance_id: otherId(1) }; owner.open(nextBinding);
  assert.throws(() => owner.prepare(nextBinding.decoder_instance_id), /pending_byte_limit/);
  assert.equal(owner.pendingBytes, size); assert.equal(owner.pending(nextBinding.decoder_instance_id), null);
  assert.strictEqual(owner.pending(binding.decoder_instance_id), pending);
  owner.acknowledge(binding.decoder_instance_id, pending.body, 200, receipt(pending));
  assert.equal(owner.pendingBytes, 0);
  assert.equal(owner.prepare(nextBinding.decoder_instance_id).checkpoint.checkpoint_sequence, 0);
  const tiny = new PendingEvidenceOwner({ bodyBytes: 1 }); tiny.open(binding);
  assert.throws(() => tiny.prepare(binding.decoder_instance_id), /checkpoint_body_limit/);
  assert.equal(tiny.pendingBytes, 0); assert.equal(tiny.pending(binding.decoder_instance_id), null);
  assert.throws(() => new PendingEvidenceOwner({ pendingBytes: LIMITS.pendingBytes + 1 }), /invalid_integer/);
});
test('instrumentation quality is sticky and snapshots never expose mutable accumulator buffers', async () => {
  const { EvidenceAccumulator } = await load(); const a = new EvidenceAccumulator(binding);
  a.markInstrumentationIncomplete(); a.consume({ event_index: 0, start_frame: 0, frames: 1 });
  const old = a.snapshot(0); a.consume({ event_index: 1, start_frame: 1, frames: 1 });
  assert.equal(old.rendered_frames, 1); assert.deepEqual(old.coverage_intervals, [[0, 1]]);
  assert.equal(a.snapshot(1).instrumentation_complete, false);
  assert(Object.isFrozen(old)); assert(Object.isFrozen(a.binding));
});
test('MAX_SAFE position repetition never rounds an intermediate position-plus-weight', async () => {
  const { EvidenceAccumulator } = await load(); const a = new EvidenceAccumulator(binding);
  for (let index = 0; index < 3; index++) {
    a.consume({ event_index: index, start_frame: Number.MAX_SAFE_INTEGER - 1, frames: 1 });
    const checkpoint = a.snapshot(index);
    assert.equal(checkpoint.rendered_frames, index + 1);
    assert.equal(checkpoint.histogram.reduce((sum, [, weight]) => sum + weight, 0), index + 1);
    assert.deepEqual(checkpoint.coverage_intervals, [[Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]]);
    assert.equal(checkpoint.max_observed_frame, Number.MAX_SAFE_INTEGER);
  }
});
test('forward event gap halts without counting missing or future frames', async () => {
  const { EvidenceAccumulator } = await load(); const a = new EvidenceAccumulator(binding);
  a.consume({ event_index: 0, start_frame: 0, frames: 2 });
  const old = a.snapshot(0);
  assert.throws(() => a.consume({ event_index: 2, start_frame: 2, frames: 3 }), /event_order_conflict/);
  const next = a.snapshot(1);
  assert.equal(next.rendered_frames, old.rendered_frames);
  assert.deepEqual(next.histogram, old.histogram);
  assert.deepEqual(next.coverage_intervals, old.coverage_intervals);
  assert.equal(next.instrumentation_complete, false);
  assert.throws(() => a.consume({ event_index: 1, start_frame: 2, frames: 1 }), /instance_closed/);
});
test('invalid acknowledgement and block retain prior accepted receipt plus newer pending bytes', async () => {
  const { PendingEvidenceOwner } = await load(); const owner = new PendingEvidenceOwner(); const a = owner.open(binding);
  a.consume({ event_index: 0, start_frame: 0, frames: 1 });
  const first = owner.prepare(binding.decoder_instance_id), body = receipt(first);
  const accepted = owner.acknowledge(binding.decoder_instance_id, first.body, 200, body);
  a.consume({ event_index: 1, start_frame: 1, frames: 1 });
  const pending = owner.prepare(binding.decoder_instance_id), bytes = owner.pendingBytes;
  assert.throws(() => owner.acknowledge(binding.decoder_instance_id, pending.body, 200,
    receipt(pending, { checkpoint_sequence: 0 })), /invalid_receipt/);
  assert.strictEqual(owner.receipt(binding.decoder_instance_id), accepted);
  assert.equal(accepted.body, body);
  assert.strictEqual(owner.pending(binding.decoder_instance_id), pending);
  assert.equal(owner.pendingBytes, bytes);
  owner.block(binding.decoder_instance_id);
  assert.throws(() => owner.prepare(binding.decoder_instance_id), /reconciliation_required/);
  assert.strictEqual(owner.receipt(binding.decoder_instance_id), accepted);
  assert.strictEqual(owner.pending(binding.decoder_instance_id), pending);
  assert.equal(owner.pendingBytes, bytes);
});
