const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
  '../../../music_app/static/js/runtime/player-capture-telemetry.js'), 'utf8');
const UUID = '22222222-2222-4222-8222-222222222222';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  // All crypto/transport promises in this file are explicitly controlled.
  for (let index = 0; index < 4; index++) await new Promise(setImmediate);
}
function fixture() {
  const sandbox = vm.createContext({ ArrayBuffer, Float64Array, Uint8Array,
    TextEncoder, AbortController });
  vm.runInContext(source + '\nthis.api = PlaybackCaptureTelemetry; this.enabled = PLAYBACK_CAPTURE_ENABLED;', sandbox);
  const owners = [];
  function makeOwner({ digest = () => new Promise(() => {}),
    post = () => new Promise(() => {}) } = {}) {
    let time = 0, nextTimer = 0;
    const record = { contextCalls: 0, commands: [], hashes: [], requests: [],
      diagnostics: [], timers: new Map() };
    const owner = sandbox.api.createOwner({
      getContext: async () => {
        record.contextCalls++;
        return { ok: true, protocol: 'app-rendered-position-v1',
          expected_scope: 'v1:' + 'a'.repeat(64), source_rate: 48000, output_rate: 48000 };
      },
      postCheckpoint: (body, scope, options) => {
        record.requests.push({ body, scope, options }); return post(body, scope, options);
      },
      clock: { now: () => time, utc: () => 1800000000000 + time,
        setTimeout: (callback, delay) => {
          const id = ++nextTimer; record.timers.set(id, { callback, delay }); return id;
        }, clearTimeout: id => record.timers.delete(id) },
      crypto: { randomUUID: () => UUID, subtle: { digest: (algorithm, encoded) => {
        record.hashes.push({ algorithm, bytes: Uint8Array.from(encoded) });
        return digest(algorithm, encoded);
      } } },
      generation: () => 7,
      sendCommand: command => record.commands.push(command),
      diagnostic: reason => record.diagnostics.push(reason),
    });
    record.owner = owner;
    record.advance = ms => { time += ms; owner.tick(); };
    record.dispose = () => { owner.onScopeLost(); owner.onContextState('closed'); };
    record.feed = () => {
      const parent = owner.bindTrack({ trackPath: '/synthetic/track.flac',
        deviceId: UUID, v1SessionId: null });
      const binding = owner.linkStream(parent, { generation: 7, streamId: 1,
        sourceBase48: 0, sourceRate: 48000, outputRate: 48000 });
      assert.ok(binding);
      const enabled = record.commands.find(command => command.type === 'capture-enable');
      const buffer = new ArrayBuffer(16384), data = new Float64Array(buffer);
      data.set([1094927184, 1, enabled.ownerSerial, 1, 1, 48000, 48000, 1, 0, 0, 0, 128, 1]);
      data.set([binding.bindingSerial, 1, 0, 128, 0, 0, 0], 256);
      owner.acceptPacket(buffer);
      return { parent, binding };
    };
    owners.push(record); return record;
  }
  return { makeOwner, owners, enabled: sandbox.enabled };
}
function assertUnadmitted(record) {
  assert.equal(record.contextCalls, 0);
  assert.equal(record.timers.size, 0);
  assert.equal(record.hashes.length, 0);
  assert.equal(record.commands.filter(command => command.type === 'capture-enable').length, 0);
}

test('digest fence keeps staged OFF default and v1 positive evidence unchanged', async () => {
  const f = fixture(), hash = deferred(), first = f.makeOwner({ digest: () => hash.promise });
  assert.equal(f.enabled, false);
  assert.equal(await first.owner.enable(), true); first.feed();
  assert.equal(first.hashes.length, 1);
  const input = new TextDecoder().decode(first.hashes[0].bytes);
  assert.ok(input.startsWith('app-rendered-position-v1\n1\n'));
  const evidence = JSON.parse(input.split('\n').slice(2).join('\n'));
  assert.deepEqual(evidence.runs, [{ source_start48: 0, frames: 128, output_start: 0,
    ordinal_start: 0, epoch: 1, anchor_before: null, anchor_after: null, quality: 'unknown' }]);
  first.dispose(); hash.resolve(new ArrayBuffer(32)); await settle();
  assert.equal(first.requests.length, 0);
});

test('disposed owner retains digest fence until actual fulfillment', async () => {
  const f = fixture(), hash = deferred(), first = f.makeOwner({ digest: () => hash.promise });
  await first.owner.enable(); first.feed(); first.dispose();
  const next = f.makeOwner(), enabled = next.owner.enable();
  await settle(); assertUnadmitted(next);
  hash.resolve(new ArrayBuffer(32));
  assert.equal(await enabled, true);
  assert.equal(next.contextCalls, 1);
  assert.equal(first.requests.length, 0, 'late hash must not post abandoned evidence');
  next.dispose();
});

test('repeated replacement attempts cannot add owners while a hash is unresolved', async () => {
  const f = fixture(), hash = deferred(), first = f.makeOwner({ digest: () => hash.promise });
  await first.owner.enable(); first.feed(); first.dispose();
  const next = f.makeOwner(), pending = next.owner.enable();
  assert.equal(next.owner.enable(), pending);
  for (let index = 0; index < 12; index++) {
    const rejected = f.makeOwner();
    assert.equal(await rejected.owner.enable(), false);
    assertUnadmitted(rejected); rejected.dispose();
  }
  await settle(); assertUnadmitted(next);
  assert.equal(f.owners.reduce((n, owner) => n + owner.hashes.length, 0), 1);
  hash.resolve(new ArrayBuffer(32)); assert.equal(await pending, true); next.dispose();
});

test('digest rejection after disposal releases only the original job', async () => {
  const f = fixture(), hash = deferred(), first = f.makeOwner({ digest: () => hash.promise });
  await first.owner.enable(); first.feed(); first.dispose();
  const next = f.makeOwner(), pending = next.owner.enable();
  hash.reject(new Error('synthetic digest failure'));
  assert.equal(await pending, true); await settle();
  assert.equal(first.requests.length, 0);
  assert.equal(next.contextCalls, 1); next.dispose();
});

test('synchronous digest invocation failure cannot leak the global fence', async () => {
  const f = fixture(), first = f.makeOwner({ digest: () => { throw new Error('sync failure'); } });
  await first.owner.enable(); first.feed();
  assert.ok(first.diagnostics.includes('capture_digest_failed'));
  first.owner.onContextState('closed');
  const next = f.makeOwner();
  assert.equal(await next.owner.enable(), true); next.dispose();
});

test('cancelling a waiting successor never releases the predecessor hash', async () => {
  const f = fixture(), hash = deferred(), first = f.makeOwner({ digest: () => hash.promise });
  await first.owner.enable(); first.feed(); first.dispose();
  const cancelled = f.makeOwner(), cancelledResult = cancelled.owner.enable();
  cancelled.dispose(); assert.equal(await cancelledResult, false);
  const next = f.makeOwner(), pending = next.owner.enable();
  await settle(); assertUnadmitted(next);
  hash.resolve(new ArrayBuffer(32)); assert.equal(await pending, true);
  assertUnadmitted(cancelled); next.dispose();
});

test('nonsettlement survives timeout ticks, pagehide and repeated disposal', async () => {
  const f = fixture(), hash = deferred(), first = f.makeOwner({ digest: () => hash.promise });
  await first.owner.enable(); const { parent } = first.feed();
  first.owner.requestClose(parent, 'ended'); first.advance(180000);
  first.owner.pagehide(); first.dispose();
  const next = f.makeOwner(), pending = next.owner.enable();
  for (let index = 0; index < 6; index++) {
    first.advance(3600000); first.owner.pagehide(); first.dispose();
    await settle(); assertUnadmitted(next);
  }
  // Settle only for fixture cleanup, never as a simulated timeout result.
  hash.resolve(new ArrayBuffer(32)); assert.equal(await pending, true); next.dispose();
});

test('outstanding fetch independently blocks successor after digest settlement', async () => {
  const f = fixture(), hash = deferred(), transport = deferred();
  const first = f.makeOwner({ digest: () => hash.promise, post: () => transport.promise });
  await first.owner.enable(); first.feed(); hash.resolve(new ArrayBuffer(32)); await settle();
  assert.equal(first.requests.length, 1);
  first.dispose();
  assert.equal(first.requests[0].options.signal.aborted, true);
  const next = f.makeOwner(), pending = next.owner.enable();
  await settle(); assertUnadmitted(next);
  transport.reject(new Error('aborted transport actually settled'));
  assert.equal(await pending, true); next.dispose();
});

test('late predecessor fulfillment cannot release a successor digest job', async () => {
  const f = fixture(), oldHash = deferred(), nextHash = deferred();
  const first = f.makeOwner({ digest: () => oldHash.promise });
  await first.owner.enable(); first.feed(); first.dispose();
  const next = f.makeOwner({ digest: () => nextHash.promise }), pending = next.owner.enable();
  oldHash.resolve(new ArrayBuffer(32)); assert.equal(await pending, true);
  next.feed(); next.dispose();
  const third = f.makeOwner(), thirdPending = third.owner.enable();
  oldHash.resolve(new ArrayBuffer(32)); first.dispose(); await settle();
  assertUnadmitted(third);
  nextHash.reject(new Error('successor hash settled'));
  assert.equal(await thirdPending, true); third.dispose();
});
