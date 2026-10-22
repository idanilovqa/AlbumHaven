const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
  '../../../music_app/static/js/runtime/player-capture-telemetry.js'), 'utf8');
const UUID = '22222222-2222-4222-8222-222222222222';
const TRACK = '/synthetic/track.flac';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let index = 0; index < 4; index++) await new Promise(setImmediate);
}
function fixture(globals = {}) {
  const sandbox = vm.createContext({ ArrayBuffer, Float64Array, Uint8Array,
    TextEncoder, AbortController, ...globals });
  vm.runInContext(source + '\nthis.api = PlaybackCaptureTelemetry;', sandbox);
  function makeOwner({ digest = () => new Promise(() => {}),
    post = () => new Promise(() => {}) } = {}) {
    const commands = [], hashes = [], posts = [], diagnostics = [], timers = new Map();
    let timerId = 0, contexts = 0;
    const owner = sandbox.api.createOwner({
      getContext: async () => {
        contexts++;
        return { ok: true, protocol: 'app-rendered-position-v1',
          source_rate: 48000, output_rate: 48000, expected_scope: 'v1:' + 'a'.repeat(64) };
      },
      postCheckpoint: (body, scope, options) => {
        posts.push({ body, scope, options }); return post(body, scope, options);
      },
      clock: { now: () => 0, utc: () => 1800000000000,
        setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id) },
      crypto: { randomUUID: () => UUID, subtle: { digest: (algorithm, encoded) => {
        hashes.push({ algorithm, input: new TextDecoder().decode(encoded) });
        return digest(algorithm, encoded);
      } } },
      generation: () => 7, sendCommand: command => commands.push(command),
      diagnostic: reason => diagnostics.push(reason),
    });
    const bind = () => {
      const parent = owner.bindTrack({ trackPath: TRACK, deviceId: UUID, v1SessionId: null });
      const binding = owner.linkStream(parent, { generation: 7, streamId: 1,
        sourceBase48: 0, sourceRate: 48000, outputRate: 48000 });
      assert.ok(binding); return binding;
    };
    const send = (binding, { packet = 1, bufferId = 1, start = 0, count = 1 } = {}) => {
      const enabled = commands.find(command => command.type === 'capture-enable');
      const buffer = new ArrayBuffer(16384), data = new Float64Array(buffer);
      data.set([1094927184, 1, enabled.ownerSerial, packet, count, 48000, 48000, 1, 0, 0, 0, 128, bufferId]);
      for (let index = 0; index < count; index++) {
        const frame = start + index;
        data.set([binding.bindingSerial, 1, frame, 1, frame, frame, 0], 256 + index * 7);
      }
      owner.acceptPacket(buffer);
    };
    return { owner, commands, hashes, posts, diagnostics, timers, bind, send,
      contexts: () => contexts,
      dispose: () => { owner.onScopeLost(); owner.onContextState('closed'); } };
  }
  return { makeOwner };
}

for (const boundary of ['serialization', 'body-size encoding', 'hash-input encoding']) {
  test(boundary + ' synchronous failure before crypto releases digest admission', async () => {
    let encodes = 0;
    const globals = boundary === 'serialization'
      ? { JSON: { stringify() { throw new Error('synthetic serialization failure'); } } }
      : { TextEncoder: class {
        encode(value) {
          encodes++;
          const failureCall = boundary === 'body-size encoding' ? 1 : 2;
          if (encodes === failureCall) throw new Error('synthetic encoding failure');
          return new TextEncoder().encode(value);
        }
      } };
    const f = fixture(globals), first = f.makeOwner();
    assert.equal(await first.owner.enable(), true);
    first.send(first.bind());
    await settle();
    assert.deepEqual(first.hashes, [], 'crypto must not be invoked after preparation failed');
    assert.deepEqual(first.posts, []);
    assert.ok(first.diagnostics.includes('capture_digest_failed'));
    assert.equal(first.timers.size, 0);
    first.owner.onContextState('closed');
    const next = f.makeOwner();
    assert.equal(await next.owner.enable(), true, 'settled synchronous failure cannot strand a hash slot');
    assert.equal(next.contexts(), 1); next.dispose();
  });
}

test('active owner hashes and posts exact unchanged v1 bytes then accepts matching receipt', async () => {
  const evidence = { runs: [{ source_start48: 0, frames: 1, output_start: 0,
    ordinal_start: 0, epoch: 1, anchor_before: null, anchor_after: null, quality: 'unknown' }],
    anchors: [], gaps: [], terminal: false, terminal_reason: null };
  const expectedBody = JSON.stringify({ protocol: 'app-rendered-position-v1',
    device_uuid: UUID, capture_uuid: UUID, sequence: 1, evidence, initial_path: TRACK });
  const expectedInput = 'app-rendered-position-v1\n1\n'
    + '{"anchors":[],"gaps":[],"runs":[{"anchor_after":null,"anchor_before":null,"epoch":1,"frames":1,'
    + '"ordinal_start":0,"output_start":0,"quality":"unknown","source_start48":0}],'
    + '"terminal":false,"terminal_reason":null}';
  const expectedDigest = createHash('sha256').update(expectedInput).digest('hex');
  const f = fixture(), first = f.makeOwner({
    digest: (algorithm, encoded) => {
      assert.equal(algorithm, 'SHA-256');
      assert.equal(new TextDecoder().decode(encoded), expectedInput);
      return Promise.resolve(Uint8Array.from(createHash('sha256').update(encoded).digest()).buffer);
    },
    post: body => {
      assert.equal(body, expectedBody);
      return Promise.resolve({ status: 200, data: { ok: true, capture_uuid: UUID, sequence: 1,
        digest: expectedDigest, terminal: false, accepted_known_frames: 1, accepted_lost_frames: 0 } });
    },
  });
  await first.owner.enable(); first.send(first.bind()); await settle();
  assert.equal(first.hashes.length, 1); assert.equal(first.posts.length, 1);
  assert.equal(first.posts[0].body, expectedBody);
  assert.equal(first.posts[0].scope, 'v1:' + 'a'.repeat(64));
  assert.equal(first.posts[0].options.signal.aborted, false);
  assert.deepEqual(first.diagnostics, []);
  first.dispose();
  const next = f.makeOwner();
  assert.equal(await next.owner.enable(), true, 'hash and receipt settlement release both async fences');
  next.dispose();
});

test('pending capacity holds packet credit through hash and releases it on actual settlement', async () => {
  const hash = deferred(), transport = deferred(), f = fixture();
  const first = f.makeOwner({ digest: () => hash.promise, post: () => transport.promise });
  await first.owner.enable();
  const binding = first.bind();
  first.send(binding, { count: 100 });
  assert.equal(first.hashes.length, 1);
  assert.equal(first.commands.filter(command => command.type === 'capture-credit'
    && command.bufferId === 1).length, 1);
  // At the public v1 charge contract, 100 frozen runs plus this path's parent
  // leave room for only seven more charged runs. A sixteen-run second packet
  // cannot be fully copied or credited while that hash retains its evidence.
  first.send(binding, { packet: 2, bufferId: 2, start: 100, count: 16 });
  await settle();
  assert.equal(first.commands.filter(command => command.type === 'capture-credit'
    && command.bufferId === 2).length, 0);
  assert.equal(first.hashes.length, 1);
  assert.equal(first.posts.length, 0);
  assert.deepEqual(first.diagnostics, []);
  hash.resolve(new ArrayBuffer(32)); await settle();
  assert.equal(first.commands.filter(command => command.type === 'capture-credit'
    && command.bufferId === 2).length, 1, 'settlement releases retained evidence capacity and drains the held packet');
  assert.equal(first.posts.length, 1);
  assert.equal(JSON.parse(first.posts[0].body).evidence.runs.length, 100,
    'new pending runs cannot change the frozen first body');
  assert.equal(first.hashes.length, 1, 'pending transport still owns the first frozen batch');
  assert.deepEqual(first.diagnostics, []);
  first.dispose(); transport.reject(new Error('owned transport cleanup')); await settle();
});
