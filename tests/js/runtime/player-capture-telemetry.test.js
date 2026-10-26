const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/player-capture-telemetry.js'), 'utf8');
const DEVICE = '11111111-1111-4111-8111-111111111111';
const CAPTURE = '22222222-2222-4222-8222-222222222222';
const PROTOCOL = 'app-rendered-position-v1';
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function receipt(body, knownBefore = 0, lostBefore = 0) {
  const value = JSON.parse(body), evidence = value.evidence;
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`${PROTOCOL}\n${value.sequence}\n${canonical(evidence)}`));
  return { status: 200, data: { ok: true, capture_uuid: value.capture_uuid, sequence: value.sequence,
    digest: Buffer.from(digest).toString('hex'), terminal: evidence.terminal,
    accepted_known_frames: knownBefore + evidence.runs.reduce((sum, run) => sum + run.frames, 0),
    accepted_lost_frames: lostBefore + evidence.gaps.reduce((sum, gap) => sum + gap.positive_frames, 0) } };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function settle() { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); }
async function waitForCondition(predicate, label) {
  // Native WebCrypto completion is not bounded by a count of event-loop turns.
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(predicate(), `${label} did not complete within 5 seconds`);
}
function fixture(post = body => receipt(body)) {
  let time = 0, wall = 1800000000000, nextTimer = 1;
  const timers = new Map(), sent = [], requests = [], diagnostics = [];
  const context = vm.createContext({ ArrayBuffer, Float64Array, Uint8Array, TextEncoder,
    AbortController, console, Set, Map });
  vm.runInContext(`${source}\nthis.captureApi = PlaybackCaptureTelemetry; this.activation = PLAYBACK_CAPTURE_ENABLED;`, context);
  const options = {
    getContext: async () => ({ ok: true, protocol: PROTOCOL, expected_scope: `v1:${'a'.repeat(64)}`, source_rate: 48000, output_rate: 48000 }),
    postCheckpoint: (body, scope, options) => { requests.push({ body, scope, options }); return post(body, scope, options); },
    clock: { now: () => time, utc: () => wall,
      setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: time + ms }); return id; },
      clearTimeout: id => timers.delete(id) },
    crypto: { randomUUID: () => CAPTURE, subtle: webcrypto.subtle }, generation: () => 7,
    sendCommand: (command, transfer) => sent.push({ command, transfer }), diagnostic: reason => diagnostics.push(reason),
  };
  const owner = context.captureApi.createOwner(options);
  return { owner, sent, requests, diagnostics, context,
    newOwner: () => context.captureApi.createOwner(options),
    advance(ms, utcDelta = ms) { time += ms; wall += utcDelta;
      const due = [...timers].filter(([, value]) => value.at <= time);
      for (const [id, value] of due) { if (timers.delete(id)) value.fn(); }
      owner.tick();
    },
    bind(path = '/fixture/track.flac') {
      const parent = owner.bindTrack({ trackPath: path, deviceId: DEVICE, v1SessionId: null });
      const binding = parent && owner.linkStream(parent, { generation: 7, streamId: sent.length + 1,
        sourceBase48: 96000, sourceRate: 48000, outputRate: 48000 });
      return { parent, binding };
    },
  };
}
function packet(f, binding, { packetOrdinal = 1, bufferId = 1, ordinal = 0, frames = 128,
  sourceStart = 96000, output = ordinal, epoch = 1, ack = false, probe = null, gap = null, runs = true } = {}) {
  const ownerSerial = f.sent.find(item => item.command.type === 'capture-enable').command.ownerSerial;
  const buffer = new ArrayBuffer(16384), data = new Float64Array(buffer);
  data.set([1094927184, 1, ownerSerial, packetOrdinal, runs ? 1 : 0, 48000, 48000, epoch, gap ? 1 : 0, ack ? 1 : 0, probe ? 1 : 0, 128, bufferId]);
  if (runs) data.set([binding.bindingSerial, epoch, sourceStart, frames, output, ordinal, 0], 256);
  if (ack) data.set([binding.bindingSerial, packetOrdinal, ordinal + (runs ? frames : 0), epoch], 96);
  if (probe) data.set([probe.probe_id, epoch, output, 128], 128);
  if (gap) data.set([binding.bindingSerial, gap.epoch ?? 0, gap.start, gap.end, gap.frames, gap.start, gap.end, 1], 32);
  return buffer;
}

test('staged activation gate remains false and enable owns exactly four fixed buffers', async () => {
  const f = fixture();
  assert.equal(f.context.activation, false);
  assert.equal(await f.owner.enable(), true);
  const enable = f.sent.find(item => item.command.type === 'capture-enable');
  assert.equal(enable.command.buffers.length, 4);
  assert.ok(enable.command.buffers.every(buffer => buffer.byteLength === 16384));
  assert.equal(enable.transfer, enable.command.buffers);
});

test('initial positive packet admits immediately with source coordinates and identity-free evidence', async () => {
  const f = fixture(); await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  assert.equal(f.requests.length, 1);
  const body = JSON.parse(f.requests[0].body);
  assert.equal(body.initial_path, '/fixture/track.flac');
  assert.equal(body.sequence, 1);
  assert.equal(body.v1_session_uuid, undefined);
  assert.deepEqual(body.evidence.runs[0], { source_start48: 96000, frames: 128, output_start: 0,
    ordinal_start: 0, epoch: 1, anchor_before: null, anchor_after: null, quality: 'unknown' });
  assert.equal(JSON.stringify(body.evidence).includes(CAPTURE), false);
  assert.equal(JSON.stringify(body.evidence).includes('bindingSerial'), false);
  assert.equal(f.sent.filter(item => item.command.type === 'capture-credit').length, 1);
});

test('timeout retains the original unsettled attempt and retries identical bytes after settlement', async () => {
  const first = deferred(); let attempts = 0;
  const f = fixture(body => ++attempts === 1 ? first.promise : receipt(body));
  await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  f.advance(10000); await settle();
  assert.equal(f.requests[0].options.signal.aborted, true);
  f.advance(30000); await settle();
  assert.equal(f.requests.length, 1, 'abort cannot vacate an unsettled fetch promise');
  first.reject(new Error('commit acknowledgement lost')); await settle();
  f.advance(2000); await settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].body, f.requests[0].body);
});

test('terminal request cannot mutate an in-flight positive batch and follows it with empty sequence two', async () => {
  const first = deferred(); let calls = 0;
  const f = fixture(body => ++calls === 1 ? first.promise : receipt(body, 128));
  await f.owner.enable(); const { parent, binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  const original = f.requests[0].body;
  f.owner.requestClose(parent, 'ended'); f.owner.unlinkStream(binding);
  f.owner.acceptPacket(packet(f, binding, { packetOrdinal: 2, bufferId: 2, runs: false, ack: true, ordinal: 128 }));
  assert.equal(f.requests.length, 1);
  first.resolve(await receipt(original));
  await waitForCondition(() => f.requests.length >= 2, 'terminal checkpoint POST'); await settle();
  assert.equal(f.requests[0].body, original);
  const terminal = JSON.parse(f.requests[1].body);
  assert.equal(terminal.sequence, 2);
  assert.deepEqual(terminal.evidence.runs, []);
  assert.equal(terminal.evidence.terminal, true);
  assert.equal(terminal.evidence.terminal_reason, 'ended');
  assert.equal(terminal.initial_path, undefined);
});

test('scope loss discards pending data without replaying under a fresh owner', async () => {
  const pending = deferred(); const f = fixture(() => pending.promise);
  await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  f.owner.onScopeLost(); f.advance(120000); await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.owner.bindTrack({ trackPath: '/other', deviceId: DEVICE }), null);
  assert.ok(f.diagnostics.includes('capture_scope_lost'));
  pending.reject(new Error('aborted')); await settle();
});

test('eight track parents and eight stream bindings are separate hard caps', async () => {
  const f = fixture(); await f.owner.enable();
  const handles = Array.from({ length: 8 }, () => f.owner.bindTrack({ trackPath: '/fixture.flac', deviceId: DEVICE }));
  assert.ok(handles.every(Boolean));
  assert.equal(f.owner.bindTrack({ trackPath: '/ninth.flac', deviceId: DEVICE }), null);
  const links = Array.from({ length: 8 }, (_, index) => f.owner.linkStream(handles[0], {
    generation: 7, streamId: index + 1, sourceBase48: index * 100, sourceRate: 48000, outputRate: 48000 }));
  assert.ok(links.every(Boolean));
  assert.equal(f.owner.linkStream(handles[1], { generation: 7, streamId: 9,
    sourceBase48: 0, sourceRate: 48000, outputRate: 48000 }), null);
});

test('mixed-epoch losses carry exact positive count with null epoch and unknown source distribution', async () => {
  const f = fixture(); await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding, { ordinal: 500, gap: { epoch: 0, start: 0, end: 500, frames: 250 } }));
  await waitForCondition(() => f.requests.length >= 1, 'mixed-epoch checkpoint POST');
  const gap = JSON.parse(f.requests[0].body).evidence.gaps[0];
  assert.equal(gap.epoch, null); assert.equal(gap.positive_frames, 250);
  assert.equal(gap.ordinal_end, 500); assert.equal(gap.source_start48, undefined);
});

test('clock jump or delayed anchor retains source evidence but never fabricates bounded wall time', async () => {
  const f = fixture(); await f.owner.enable(); const { binding } = f.bind();
  f.owner.onContextState('running');
  const probe = f.sent.find(item => item.command.type === 'capture-probe').command;
  f.advance(300, 5000);
  f.owner.acceptPacket(packet(f, binding, { probe, epoch: 2 }));
  await waitForCondition(() => f.requests.length >= 1, 'clock-jump checkpoint POST');
  const evidence = JSON.parse(f.requests[0].body).evidence;
  assert.equal(evidence.runs[0].quality, 'unknown');
  assert.equal(evidence.anchors[0].quality, 'unknown');
  assert.equal(evidence.anchors[0].utc_lower_ms, null);
  assert.equal(evidence.anchors[0].utc_upper_ms, null);
});

test('bad packet identity stops capture instead of returning a forged credit', async () => {
  const f = fixture(); await f.owner.enable(); const { binding } = f.bind();
  const buffer = packet(f, binding); new Float64Array(buffer)[2] = 999;
  f.owner.acceptPacket(buffer); await settle();
  assert.equal(f.requests.length, 0);
  assert.equal(f.sent.filter(item => item.command.type === 'capture-credit').length, 0);
  assert.ok(f.diagnostics.includes('invalid_capture_packet'));
});

test('retry lifetime ends capture without allocating a new parent identity', async () => {
  const pending = deferred(); const f = fixture(() => pending.promise);
  await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  f.advance(120000); await settle();
  assert.equal(f.requests.length, 1);
  assert.ok(f.diagnostics.includes('transport_abandoned'));
  assert.equal(f.owner.bindTrack({ trackPath: '/retry.flac', deviceId: DEVICE }), null);
  pending.reject(new Error('aborted')); await settle();
});

test('queue saturation withholds the same physical packet credit until frozen bytes are acknowledged', async () => {
  const first = deferred(); let calls = 0;
  const f = fixture(body => ++calls === 1 ? first.promise : receipt(body, 128));
  await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  const crowded = packet(f, binding, { packetOrdinal: 2, bufferId: 2, ordinal: 128 });
  const data = new Float64Array(crowded); data[4] = 256;
  for (let index = 0; index < 256; index++) data.set([binding.bindingSerial, 1, 1000 + index,
    1, 128 + index, 128 + index, 0], 256 + index * 7);
  f.owner.acceptPacket(crowded); await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.sent.filter(item => item.command.type === 'capture-credit' && item.command.bufferId === 2).length, 0);
  assert.equal(f.sent.filter(item => item.command.type === 'capture-enable').length, 1);
  f.owner.onScopeLost(); first.reject(new Error('retired')); await settle();
});

test('pagehide does not create a second request beside an unsettled attempt', async () => {
  const pending = deferred(); const f = fixture(() => pending.promise);
  await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  f.owner.pagehide(); await settle();
  assert.equal(f.requests.length, 1);
  f.owner.onScopeLost(); pending.reject(new Error('retired')); await settle();
});

test('a replayed packet ordinal is rejected instead of double-counting consumption', async () => {
  const f = fixture(); await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  f.owner.acceptPacket(packet(f, binding, { bufferId: 2 })); await settle();
  assert.equal(f.requests.length, 1);
  assert.ok(f.diagnostics.includes('invalid_capture_packet'));
});

test('middleware authentication failure ends owner even without a capture error body', async () => {
  const f = fixture(async () => ({ status: 403, data: { detail: 'Forbidden' } }));
  await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  await waitForCondition(() => f.diagnostics.includes('capture_scope_lost'), 'authentication failure retirement');
  f.advance(30000); await settle();
  assert.equal(f.requests.length, 1); assert.ok(f.diagnostics.includes('capture_scope_lost'));
});

test('duplicate unbind acknowledgements fail capture validation without throwing into playback', async () => {
  const f = fixture(); await f.owner.enable(); const { binding } = f.bind();
  f.owner.unlinkStream(binding);
  const buffer = packet(f, binding, { runs: false, ack: true, ordinal: 0 });
  const data = new Float64Array(buffer); data[9] = 2; data.set(data.slice(96, 100), 100);
  assert.doesNotThrow(() => f.owner.acceptPacket(buffer));
  assert.ok(f.diagnostics.includes('invalid_capture_packet'));
  assert.equal(f.requests.length, 0);
});

test('closed context disposes credits but successor waits for the original unsettled transport', async () => {
  const pending = deferred(); const f = fixture(() => pending.promise);
  await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  const original = f.requests[0].body;
  f.owner.close('owner_closed'); f.owner.onContextState('closed');
  const next = f.newOwner(); let enabled = false;
  const ready = next.enable().then(value => { enabled = value; return value; });
  await settle(); assert.equal(enabled, false);
  f.advance(120000); await settle();
  assert.equal(enabled, false, 'abort/queue abandonment cannot settle an outstanding transport');
  assert.equal(f.sent.filter(item => item.command.type === 'capture-enable').length, 1);
  assert.equal(f.requests[0].body, original);
  pending.reject(new Error('settled after abort')); await settle();
  assert.equal(await ready, true);
  assert.equal(f.sent.filter(item => item.command.type === 'capture-enable').length, 2);
  assert.equal(f.requests.length, 1);
  next.onScopeLost();
});

test('a superseded successor releases the one bounded waiter without starting capture', async () => {
  const f = fixture(); await f.owner.enable();
  const next = f.newOwner(), waiting = next.enable();
  next.close('owner_closed'); assert.equal(await waiting, false);
  const replacement = f.newOwner(), ready = replacement.enable();
  f.owner.close('owner_closed'); f.owner.onContextState('closed'); await settle();
  assert.equal(await ready, true);
  replacement.onScopeLost();
});

test('lost terminal acknowledgement replays the exact terminal sequence and bytes', async () => {
  let terminalAttempts = 0, terminalReceiptReady = false;
  const f = fixture(async body => {
    const value = JSON.parse(body);
    if (value.evidence.terminal && ++terminalAttempts === 1) throw new Error('terminal commit acknowledgement lost');
    const response = await receipt(body, value.sequence === 1 ? 0 : 128);
    if (value.evidence.terminal) terminalReceiptReady = true;
    return response;
  });
  await f.owner.enable(); const { parent, binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  f.owner.requestClose(parent, 'ended'); f.owner.unlinkStream(binding);
  f.owner.acceptPacket(packet(f, binding, { packetOrdinal: 2, bufferId: 2, runs: false, ack: true, ordinal: 128 }));
  await waitForCondition(() => f.requests.length >= 2, 'first terminal POST');
  await settle(); assert.equal(f.requests.length, 2);
  const terminal = f.requests[1].body; assert.equal(JSON.parse(terminal).evidence.terminal, true);
  assert.equal(JSON.parse(terminal).sequence, 2);
  assert.deepEqual(JSON.parse(terminal).evidence.runs, []);
  f.advance(999); await settle();
  assert.equal(f.requests.length, 2, 'terminal replay must respect the initial backoff');
  f.advance(1001);
  await waitForCondition(() => f.requests.length >= 3, 'terminal replay POST');
  assert.equal(f.requests.length, 3); assert.equal(f.requests[2].body, terminal);
  await waitForCondition(() => terminalReceiptReady, 'terminal replay receipt');
  await settle();
  assert.equal(terminalAttempts, 2);
  assert.deepEqual(f.diagnostics, []);
  f.advance(30000); await settle();
  assert.equal(f.requests.length, 3, 'acknowledged terminal must not replay again');
});

test('acknowledged frozen bytes release bounded backpressure and return one withheld credit', async () => {
  const pending = deferred(); let calls = 0, accepted = 128;
  const f = fixture(async body => {
    if (++calls === 1) return pending.promise;
    const result = await receipt(body, accepted); accepted = result.data.accepted_known_frames; return result;
  });
  await f.owner.enable(); const { binding } = f.bind();
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  const crowded = packet(f, binding, { packetOrdinal: 2, bufferId: 2, ordinal: 128 });
  const data = new Float64Array(crowded); data[4] = 256;
  for (let index = 0; index < 256; index++) data.set([binding.bindingSerial, 1, 1000 + index,
    1, 128 + index, 128 + index, 0], 256 + index * 7);
  f.owner.acceptPacket(crowded); await settle();
  assert.equal(f.sent.filter(item => item.command.type === 'capture-credit' && item.command.bufferId === 2).length, 0);
  pending.resolve(await receipt(f.requests[0].body));
  await waitForCondition(() => f.sent.some(item => item.command.type === 'capture-credit'
    && item.command.bufferId === 2), 'acknowledged held-buffer credit');
  assert.equal(f.sent.filter(item => item.command.type === 'capture-credit' && item.command.bufferId === 2).length, 1);
  assert.deepEqual(f.diagnostics, []);
  assert.ok(f.requests.every(request => Buffer.byteLength(request.body) <= 32768));
  assert.equal(new Set(f.requests.map(request => JSON.parse(request.body).capture_uuid)).size, 1);
});

test('actual suspension requests an immediate nonterminal flush including a late pause packet', async () => {
  const f = fixture(body => receipt(body, JSON.parse(body).sequence === 1 ? 0 : 128));
  await f.owner.enable(); const { binding } = f.bind();
  f.owner.onContextState('running');
  f.owner.acceptPacket(packet(f, binding));
  await waitForCondition(() => f.requests.length >= 1, 'initial checkpoint POST'); await settle();
  f.owner.onContextState('suspended');
  f.owner.acceptPacket(packet(f, binding, { packetOrdinal: 2, bufferId: 2, ordinal: 128, epoch: 2 }));
  await waitForCondition(() => f.requests.length >= 2, 'suspension checkpoint POST');
  assert.equal(f.requests.length, 2);
  const value = JSON.parse(f.requests[1].body);
  assert.equal(value.evidence.terminal, false); assert.equal(value.evidence.runs[0].frames, 128);
});
