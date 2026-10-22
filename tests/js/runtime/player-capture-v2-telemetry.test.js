const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
  '../../../music_app/static/js/runtime/player-capture-telemetry.js'), 'utf8');
const V1 = 'app-rendered-position-v1', V2 = 'app-rendered-position-v2';
const UUID = '22222222-2222-4222-8222-222222222222';
const TRACK = '/synthetic/track.flac';
async function settle() {
  for (let index = 0; index < 4; index++) await new Promise(setImmediate);
}
function fixture(supported = [V2], uuid = UUID) {
  const context = vm.createContext({ ArrayBuffer, Float64Array, Uint8Array, TextEncoder, AbortController });
  vm.runInContext(source + '\nthis.api = PlaybackCaptureTelemetry;', context);
  const commands = [], hashes = [], diagnostics = [];
  let generation = 7, resolveHash, timer = 0;
  const hash = new Promise(resolve => { resolveHash = resolve; });
  const owner = context.api.createOwner({
    getContext: async () => ({ ok: true, protocol: V1, source_rate: 48000, output_rate: 48000,
      expected_scope: 'v1:' + 'a'.repeat(64), ...(supported === undefined ? {} : { supported_protocols: supported }) }),
    postCheckpoint: () => new Promise(() => {}),
    clock: { now: () => 0, utc: () => 1800000000000, setTimeout: () => ++timer, clearTimeout: () => {} },
    crypto: { randomUUID: () => uuid, subtle: { digest: (algorithm, input) => {
      hashes.push({ algorithm, input: new TextDecoder().decode(input) }); return hash;
    } } },
    generation: () => generation, sendCommand: command => commands.push(command),
    diagnostic: reason => diagnostics.push(reason),
  });
  function bind({ streamId = 1, base = 100 } = {}) {
    const parent = owner.bindTrack({ trackPath: TRACK, deviceId: UUID });
    assert.ok(parent);
    const binding = owner.linkStream(parent, { generation, streamId, sourceBase48: base,
      sourceRate: 48000, outputRate: 48000 });
    assert.ok(binding); return binding;
  }
  function send(binding, { version = 2, continuity = 3, packet = 1, bufferId = 1,
    sourceStart = binding.sourceBase48, ordinal = 0, output = 0, count = 1 } = {}) {
    const enabled = commands.find(command => command.type === 'capture-enable');
    const buffer = new ArrayBuffer(16384), data = new Float64Array(buffer);
    data.set([1094927184, version, enabled.ownerSerial, packet, count, 48000, 48000, 1, 0, 0, 0, 128, bufferId]);
    for (let index = 0; index < count; index++) data.set([
      binding.bindingSerial, 1, sourceStart + index, 1, output + index, ordinal + index,
      version === 1 ? 0 : continuity,
    ], 256 + index * 7);
    owner.acceptPacket(buffer);
  }
  async function dispose() {
    owner.onScopeLost(); owner.onContextState('closed'); resolveHash(new ArrayBuffer(32)); await settle();
  }
  return { owner, commands, hashes, diagnostics, bind, send, dispose, resolveHash,
    setGeneration: value => { generation = value; } };
}

for (const supported of [null, [V1], [V2 + '-unknown']]) {
  test('unadvertised v2 retains exact v1 enable and evidence: ' + JSON.stringify(supported), async () => {
    const f = fixture(supported);
    assert.equal(await f.owner.enable(), true);
    const enable = f.commands.find(command => command.type === 'capture-enable');
    assert.equal(Object.hasOwn(enable, 'packetVersion'), false);
    f.send(f.bind({ base: 0 }), { version: 1 }); await settle();
    assert.equal(f.hashes.length, 1);
    assert.ok(f.hashes[0].input.startsWith(V1 + '\n1\n'));
    const evidence = JSON.parse(f.hashes[0].input.split('\n')[2]);
    assert.equal(Object.hasOwn(evidence, 'owner_uuid'), false);
    assert.deepEqual(evidence.runs[0], { source_start48: 0, frames: 1, output_start: 0,
      ordinal_start: 0, epoch: 1, anchor_before: null, anchor_after: null, quality: 'unknown' });
    await f.dispose();
  });
}

test('advertised v2 hashes owner and immutable original binding after engine generation changes', async () => {
  const f = fixture();
  assert.equal(await f.owner.enable(), true);
  assert.equal(f.commands.find(command => command.type === 'capture-enable').packetVersion, 2);
  const binding = f.bind(); f.setGeneration(8);
  f.send(binding); await settle();
  assert.equal(f.hashes.length, 1);
  const expected = V2 + '\n1\n' +
    '{"anchors":[],"gaps":[],"owner_uuid":"' + UUID + '","runs":[{"anchor_after":null,"anchor_before":null,' +
    '"binding_serial":1,"continuity_serial":3,"epoch":1,"frames":1,"generation":7,"ordinal_start":0,' +
    '"output_start":0,"quality":"unknown","source_base48":100,"source_start48":100,"stream_id":1}],' +
    '"terminal":false,"terminal_reason":null}';
  assert.equal(f.hashes[0].algorithm, 'SHA-256');
  assert.equal(f.hashes[0].input, expected);
  assert.equal(createHash('sha256').update(f.hashes[0].input).digest('hex'),
    createHash('sha256').update(expected).digest('hex'));
  assert.deepEqual(f.diagnostics, []); await f.dispose();
});

for (const bad of [{ version: 1 }, { continuity: 0 }, { sourceStart: 99 }]) {
  test('negotiated v2 rejects incompatible packet ' + JSON.stringify(bad), async () => {
    const f = fixture(); await f.owner.enable(); f.send(f.bind(), bad); await settle();
    assert.equal(f.hashes.length, 0);
    assert.ok(f.diagnostics.includes('invalid_capture_packet'));
    assert.ok(f.commands.some(command => command.type === 'capture-disable'));
    await f.dispose();
  });
}

test('v2 rejects zero owner UUID before transferring capture credits', async () => {
  const f = fixture([V2], '00000000-0000-0000-0000-000000000000');
  assert.equal(await f.owner.enable(), false);
  assert.equal(f.commands.some(command => command.type === 'capture-enable'), false);
  assert.ok(f.diagnostics.includes('unsupported_capture_owner')); await f.dispose();
});

test('v2 logical run reservation holds the next packet until digest settlement', async () => {
  const f = fixture(); await f.owner.enable(); const binding = f.bind();
  f.send(binding, { count: 50 }); await settle();
  assert.equal(f.hashes.length, 1);
  assert.equal(f.commands.filter(command => command.type === 'capture-credit' && command.bufferId === 1).length, 1);
  f.send(binding, { packet: 2, bufferId: 2, sourceStart: 150, ordinal: 50, output: 50, count: 8 });
  await settle();
  assert.equal(f.commands.filter(command => command.type === 'capture-credit' && command.bufferId === 2).length, 0);
  assert.equal(f.hashes.length, 1);
  f.resolveHash(new ArrayBuffer(32)); await settle();
  assert.equal(f.commands.filter(command => command.type === 'capture-credit' && command.bufferId === 2).length, 1);
  assert.deepEqual(f.diagnostics, []);
  await f.dispose();
});
