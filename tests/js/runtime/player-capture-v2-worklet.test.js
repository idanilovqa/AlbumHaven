const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
  '../../../music_app/static/js/audio-worklets/gapless-playback-processor.js'), 'utf8');

function fixture(version = 2) {
  let Processor;
  const packets = [], messages = [];
  const context = vm.createContext({ ArrayBuffer, Float32Array, Float64Array,
    sampleRate: 48000, currentFrame: 0, currentTime: 0,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { onmessage: null, postMessage(message) {
          if (message.type === 'capture-packet') packets.push(new Float64Array(message.buffer.slice(0)));
          else messages.push({ ...message });
        } };
      }
    },
    registerProcessor(name, value) { assert.equal(name, 'album-haven-gapless-playback'); Processor = value; },
  });
  vm.runInContext(source, context);
  const processor = new Processor();
  const send = message => processor.port.onmessage({ data: { generation: 1, ...message } });
  send({ type: 'configure', sampleRate: 48000, currentCapacityFrames: 32,
    continuityCapacityFrames: 32, startupBufferFrames: 1 });
  send({ type: 'capture-enable', ownerSerial: 1, sourceRate: 48000, outputRate: 48000,
    buffers: Array.from({ length: 4 }, () => new ArrayBuffer(16384)),
    ...(version === 1 ? {} : { packetVersion: version }) });
  function bind(streamId, sourceBase48 = 0) {
    send({ type: 'capture-bind', ownerSerial: 1, slot: streamId,
      bindingSerial: streamId, streamId, sourceBase48 });
  }
  function enqueue(role, streamId, frames, sample, sequence = 0) {
    send({ type: 'enqueue', role, streamId, sequence, frameCount: frames,
      pcm: new Float32Array(frames * 2).fill(sample) });
  }
  function render(frames) {
    const output = [new Float32Array(frames), new Float32Array(frames)];
    assert.equal(processor.process([], [output]), true);
    context.currentFrame += frames; context.currentTime = context.currentFrame / 48000;
    assert.equal(messages.some(message => message.type === 'protocol-reject'), false);
    return output[0];
  }
  function runs() {
    return packets.flatMap(packet => Array.from({ length: packet[4] }, (_, index) => {
      const offset = 256 + index * 7;
      return { binding: packet[offset], epoch: packet[offset + 1], source: packet[offset + 2],
        frames: packet[offset + 3], output: packet[offset + 4], ordinal: packet[offset + 5],
        continuity: packet[offset + 6], version: packet[1] };
    }));
  }
  return { send, bind, enqueue, render, runs, packets };
}

for (const version of [1, 2]) {
  test('actual EOS handover preserves PCM and version ' + version + ' capture contract', () => {
    const f = fixture(version);
    f.bind(1); f.bind(2, 100);
    f.enqueue('current', 1, 4, 0.25); f.enqueue('continuity', 2, 4, 0.5);
    f.send({ type: 'eos', role: 'current', streamId: 1, emittedFrames: 4, authoritativeTotalFrames: 4 });
    f.send({ type: 'play' });
    assert.deepEqual(Array.from(f.render(8)), [0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.5]);
    f.send({ type: 'pause' });
    const runs = f.runs();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map(run => run.source), [0, 100]);
    assert.deepEqual(runs.map(run => run.output), [0, 4]);
    assert.deepEqual(runs.map(run => run.ordinal), [0, 4]);
    assert.notEqual(runs[0].epoch, runs[1].epoch, 'existing timing barrier remains');
    assert.ok(runs.every(run => run.version === version));
    if (version === 1) assert.deepEqual(runs.map(run => run.continuity), [0, 0]);
    else {
      assert.ok(runs[0].continuity > 0);
      assert.equal(runs[0].continuity, runs[1].continuity);
    }
  });
}

test('pause/resume breaks continuity even with adjacent output coordinates', () => {
  const f = fixture();
  f.bind(1); f.enqueue('current', 1, 8, 0.25); f.send({ type: 'play' });
  f.render(4); f.send({ type: 'pause' }); f.send({ type: 'play' }); f.render(4); f.send({ type: 'pause' });
  const runs = f.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].output + runs[0].frames, runs[1].output);
  assert.equal(runs[0].ordinal + runs[0].frames, runs[1].ordinal);
  assert.ok(runs[1].continuity > runs[0].continuity);
});

test('prepared seek records the visited offset but does not join continuity', () => {
  const f = fixture();
  f.bind(1); f.bind(2, 100);
  f.enqueue('current', 1, 8, 0.25); f.enqueue('continuity', 2, 4, 0.5);
  f.send({ type: 'play' }); f.render(4);
  f.send({ type: 'prepare-seek', streamId: 2, timelineStartFrame: 100 });
  assert.deepEqual(Array.from(f.render(4)), [0.5, 0.5, 0.5, 0.5]);
  f.send({ type: 'pause' });
  const runs = f.runs();
  assert.deepEqual(runs.map(run => run.source), [0, 100]);
  assert.ok(runs[1].continuity > runs[0].continuity);
  assert.equal(runs[0].output + runs[0].frames, runs[1].output);
});

test('underrun emits no positive silence interval and breaks later continuity', () => {
  const f = fixture();
  f.bind(1); f.enqueue('current', 1, 2, 0.25); f.send({ type: 'play' });
  assert.deepEqual(Array.from(f.render(4)), [0.25, 0.25, 0, 0]);
  f.enqueue('current', 1, 2, 0.5, 1); f.render(2); f.send({ type: 'pause' });
  const runs = f.runs();
  assert.deepEqual(runs.map(run => run.frames), [2, 2]);
  assert.deepEqual(runs.map(run => run.output), [0, 4]);
  assert.deepEqual(runs.map(run => run.ordinal), [0, 2]);
  assert.ok(runs[1].continuity > runs[0].continuity);
});

for (const kind of ['long-loop', 'short-loop']) {
  test('validated ' + kind + ' wrap preserves output continuity without filling source coverage', () => {
    const f = fixture();
    f.bind(1); f.bind(2);
    f.enqueue('current', 1, 2, 0.25);
    f.send({ type: 'set-loop', active: true, kind, startFrame: 0, endFrame: 2, retainedStreamId: 2 });
    f.enqueue('continuity', 2, 2, 0.5);
    f.send({ type: 'play' });
    const frames = kind === 'short-loop' ? 6 : 4;
    assert.deepEqual(Array.from(f.render(frames)), [0.25, 0.25, ...Array(frames - 2).fill(0.5)]);
    f.send({ type: 'pause' });
    const runs = f.runs();
    assert.equal(runs.length, kind === 'short-loop' ? 3 : 2);
    assert.ok(runs.every(run => run.source === 0 && run.frames === 2));
    assert.ok(runs.every(run => run.continuity === runs[0].continuity));
    assert.ok(new Set(runs.map(run => run.epoch)).size > 1);
    assert.equal(runs.reduce((sum, run) => sum + run.frames, 0), frames);
  });
}

test('unsupported packet version cannot enable capture or change PCM playback', () => {
  const f = fixture(3);
  f.enqueue('current', 1, 2, 0.25); f.send({ type: 'play' });
  assert.deepEqual(Array.from(f.render(2)), [0.25, 0.25]);
  f.send({ type: 'pause' }); assert.equal(f.packets.length, 0);
});

// Additive capture-credit cadence regressions. Both sides below are the real
// owner sources. The fixture models only the two MessagePort task queues and
// transfer ownership; it neither manufactures capture packets nor copies the
// production packet, credit, continuity, loss or capacity algorithms.
const creditTelemetrySource = fs.readFileSync(path.join(__dirname,
  '../../../music_app/static/js/runtime/player-capture-telemetry.js'), 'utf8');
const CREDIT_UUID = '22222222-2222-4222-8222-222222222222';
async function settleCreditJobs() {
  for (let index = 0; index < 4; index++) await new Promise(setImmediate);
}
async function creditBridge(version, { holdBootstrapCredit = false } = {}) {
  let Processor, sequence = 0, timer = 0, resolveHash;
  const packets = [], incoming = [], outgoing = [], commands = [], hashes = [], posts = [], diagnostics = [];
  const context = vm.createContext({ ArrayBuffer, Float32Array, Float64Array,
    sampleRate: 48000, currentFrame: 0, currentTime: 0,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { onmessage: null, postMessage(message, transfers = []) {
          if (message.type !== 'capture-packet') {
            assert.notEqual(message.type, 'protocol-reject');
            return;
          }
          assert.equal(message.buffer.byteLength, 16384);
          assert.equal(transfers.length, 1);
          assert.equal(transfers[0], message.buffer);
          const data = new Float64Array(message.buffer.slice(0));
          const received = structuredClone(message, { transfer: transfers });
          const packet = { data, buffer: received.buffer, atFrame: context.currentFrame };
          packets.push(packet); incoming.push(packet);
        } };
      }
    },
    registerProcessor(name, value) { assert.equal(name, 'album-haven-gapless-playback'); Processor = value; },
  });
  vm.runInContext(source, context);
  const processor = new Processor();
  const send = message => processor.port.onmessage({ data: { generation: 7, ...message } });
  send({ type: 'configure', sampleRate: 48000, currentCapacityFrames: 128,
    continuityCapacityFrames: 128, startupBufferFrames: 1 });
  const telemetry = vm.createContext({ ArrayBuffer, Float64Array, Uint8Array, TextEncoder, AbortController });
  vm.runInContext(creditTelemetrySource + '\nthis.api = PlaybackCaptureTelemetry;', telemetry);
  const hash = new Promise(resolve => { resolveHash = resolve; });
  const owner = telemetry.api.createOwner({
    getContext: async () => ({ ok: true, protocol: 'app-rendered-position-v1',
      source_rate: 48000, output_rate: 48000, expected_scope: 'v1:' + 'a'.repeat(64),
      supported_protocols: version === 2 ? ['app-rendered-position-v2'] : ['app-rendered-position-v1'] }),
    postCheckpoint: body => { posts.push(body); return new Promise(() => {}); },
    clock: { now: () => context.currentFrame / 48,
      utc: () => 1800000000000 + context.currentFrame / 48,
      setTimeout: () => ++timer, clearTimeout: () => {} },
    crypto: { randomUUID: () => CREDIT_UUID, subtle: { digest: (algorithm, input) => {
      hashes.push({ algorithm, input: new TextDecoder().decode(input) }); return hash;
    } } },
    generation: () => 7,
    sendCommand: (message, transfers = []) => {
      if (message.type === 'capture-credit') {
        assert.equal(message.buffer.byteLength, 16384);
        assert.equal(transfers.length, 1);
        assert.equal(transfers[0], message.buffer);
        assert.ok(new Float64Array(message.buffer).every(value => value === 0),
          'telemetry clears the fully copied original packet before returning it');
      }
      commands.push({ ...message });
      outgoing.push(structuredClone(message, { transfer: transfers }));
    },
    diagnostic: reason => diagnostics.push(reason),
  });
  function deliverCommands() {
    while (outgoing.length) send(outgoing.shift());
  }
  function deliverPackets() {
    const delivered = [];
    while (incoming.length) {
      const packet = incoming.shift();
      assert.deepEqual({ ...owner.acceptPacket(packet.buffer) }, { returnBuffer: false });
      delivered.push(packet);
    }
    return delivered;
  }
  function render(frames = 128) {
    send({ type: 'enqueue', role: 'current', streamId: 1, sequence: sequence++, frameCount: frames,
      pcm: new Float32Array(frames * 2).fill(0.25) });
    const output = [new Float32Array(frames), new Float32Array(frames)];
    assert.equal(processor.process([], [output]), true);
    assert.ok(output.every(channel => channel.every(sample => sample === 0.25)),
      'credit and telemetry state must not change the actually rendered PCM');
    context.currentFrame += frames; context.currentTime = context.currentFrame / 48000;
  }
  assert.equal(await owner.enable(), true); deliverCommands();
  const parent = owner.bindTrack({ trackPath: '/synthetic/track.flac', deviceId: CREDIT_UUID });
  assert.ok(parent);
  assert.ok(owner.linkStream(parent, { generation: 7, streamId: 1,
    sourceBase48: 0, sourceRate: 48000, outputRate: 48000 }));
  deliverCommands();
  owner.onContextState('running'); deliverCommands();
  assert.equal(packets.length, 1);
  assert.equal(packets[0].data[4], 0); assert.equal(packets[0].data[10], 1);
  deliverPackets();
  if (!holdBootstrapCredit) deliverCommands();
  send({ type: 'play' });
  async function dispose() {
    owner.onScopeLost(); deliverCommands(); owner.onContextState('closed');
    resolveHash(new ArrayBuffer(32)); await settleCreditJobs();
  }
  return { packets, commands, hashes, posts, diagnostics, owner, send, render,
    deliverCommands, deliverPackets, resolveHash, dispose, frame: () => context.currentFrame };
}

for (const version of [1, 2]) {
  test('v' + version + ' real returned-credit feedback cannot create sustained short positive packets', async () => {
    const f = await creditBridge(version);
    try {
      // quantum() observes the start frame. At 48 kHz, 94 complete 128-frame
      // quanta precede the first due entry at frame 12032.
      for (let index = 0; index < 95; index++) f.render();
      assert.equal(f.packets.length, 2);
      const first = f.packets[1];
      assert.equal(first.atFrame, 12032);
      assert.equal(first.data[4], 1); assert.equal(first.data[259], 12032);
      for (let opportunity = 0; opportunity < 24; opportunity++) {
        // The main thread handles any packet after another quantum has put
        // positive PCM in the producer's next buffer, then the credit task runs.
        // Under the old source this creates the next packet every iteration.
        f.render(); f.deliverPackets(); f.deliverCommands();
      }
      assert.equal(f.packets.length, 2,
        '24 genuine return opportunities before the next due quantum must not self-sustain short packets');
      assert.equal(f.commands.filter(command => command.type === 'capture-credit').length, 2);
      assert.equal(f.hashes.length, 1, 'copying one packet returned its credit before its unresolved digest');
      assert.equal(f.posts.length, 0);
      while (f.frame() < first.atFrame + 12000) f.render();
      assert.equal(f.packets.length, 2);
      f.render();
      assert.equal(f.packets.length, 3);
      assert.equal(f.packets[2].atFrame, 24064);
      assert.equal(f.packets[2].data[259], 12032);
      f.send({ type: 'pause' });
      assert.equal(f.packets.length, 4);
      assert.equal(f.packets[3].data[259], 128, 'the explicit final tail is not delayed');
      const positive = f.packets.slice(1).map(packet => packet.data);
      assert.ok(positive.every(data => data[4] === 1));
      assert.deepEqual(positive.map(data => data[258]), [0, 12032, 24064]);
      assert.deepEqual(positive.map(data => data[260]), [0, 12032, 24064]);
      assert.deepEqual(positive.map(data => data[261]), [0, 12032, 24064]);
      assert.deepEqual(positive.map(data => data[259]), [12032, 12032, 128]);
      assert.deepEqual(positive.map(data => data[262]), version === 2 ? [1, 1, 1] : [0, 0, 0]);
      assert.equal(f.packets.slice(1).reduce((sum, packet) => sum + packet.data[259], 0), f.frame());
      assert.ok(f.packets.every(packet => packet.data[1] === version && packet.data.byteLength === 16384));
      assert.deepEqual(f.diagnostics, []);
    } finally { await f.dispose(); }
  });

  test('v' + version + ' a genuinely due positive batch may flush on a returned credit before the next quantum', async () => {
    const f = await creditBridge(version, { holdBootstrapCredit: true });
    try {
      for (let index = 0; index < 94; index++) f.render();
      assert.equal(f.frame(), 12032); assert.equal(f.packets.length, 1);
      f.deliverCommands();
      assert.equal(f.packets.length, 2, 'a due batch is not suppressed just because this entry is a credit task');
      assert.equal(f.packets[1].atFrame, 12032);
      assert.equal(f.packets[1].data[4], 1); assert.equal(f.packets[1].data[259], 12032);
      assert.equal(f.packets[1].data[8], 0); assert.equal(f.packets[1].data[9], 0);
      assert.equal(f.packets[1].data[10], 0);
      assert.deepEqual(f.diagnostics, []);
    } finally { await f.dispose(); }
  });
}

test('real v2 packet ownership withholds credit at capacity until the original digest actually settles', async () => {
  const f = await creditBridge(2);
  try {
    for (let index = 0; index < 50; index++) {
      f.send({ type: 'capture-epoch', ownerSerial: 1 }); f.render(1);
    }
    f.send({ type: 'pause' });
    const first = f.deliverPackets()[0];
    assert.equal(first.data[4], 50); assert.equal(f.hashes.length, 1);
    const firstReturns = f.commands.filter(command => command.type === 'capture-credit'
      && command.buffer === first.buffer);
    assert.equal(firstReturns.length, 1);
    assert.equal(firstReturns[0].bufferId, first.data[12]);
    assert.equal(first.buffer.byteLength, 0, 'the exact received buffer was transferred, not copied');
    f.deliverCommands(); f.send({ type: 'play' });
    for (let index = 0; index < 8; index++) {
      f.send({ type: 'capture-epoch', ownerSerial: 1 }); f.render(1);
    }
    f.send({ type: 'pause' });
    const second = f.deliverPackets()[0];
    assert.equal(second.data[4], 8); assert.equal(second.buffer.byteLength, 16384);
    assert.equal(f.commands.filter(command => command.type === 'capture-credit'
      && command.buffer === second.buffer).length, 0, 'partial copying cannot return packet ownership');
    await settleCreditJobs();
    assert.equal(f.hashes.length, 1); assert.equal(f.posts.length, 0);
    assert.equal(second.buffer.byteLength, 16384, 'event-loop settlement without digest settlement frees nothing');
    f.resolveHash(new ArrayBuffer(32)); await settleCreditJobs();
    const secondReturns = f.commands.filter(command => command.type === 'capture-credit'
      && command.buffer === second.buffer);
    assert.equal(secondReturns.length, 1); assert.equal(secondReturns[0].bufferId, second.data[12]);
    assert.equal(second.buffer.byteLength, 0);
    assert.equal(f.hashes.length, 1, 'pending transport still owns the first frozen checkpoint');
    assert.equal(f.posts.length, 1);
    assert.equal(JSON.parse(f.posts[0]).evidence.runs.length, 50);
    assert.deepEqual(f.diagnostics, []);
  } finally { await f.dispose(); }
});

for (const version of [1, 2]) {
  for (const control of ['loss', 'probe', 'retirement']) {
    test('v' + version + ' returned credit immediately recovers deferred ' + control + ' control', () => {
      const f = fixture(version); f.bind(1);
      for (let probe = 1; probe <= 4; probe++) {
        f.send({ type: 'capture-probe', ownerSerial: 1, probe_id: probe });
      }
      assert.equal(f.packets.length, 4);
      if (control === 'loss') {
        f.enqueue('current', 1, 1, 0.25); f.send({ type: 'play' });
        assert.deepEqual(Array.from(f.render(1)), [0.25]);
      } else if (control === 'probe') {
        f.send({ type: 'capture-probe', ownerSerial: 1, probe_id: 5 });
      } else f.send({ type: 'capture-unbind', ownerSerial: 1, bindingSerial: 1 });
      assert.equal(f.packets.length, 4);
      const credit = f.packets[0];
      f.send({ type: 'capture-credit', ownerSerial: 1, bufferId: credit[12], buffer: credit.buffer.slice(0) });
      assert.equal(f.packets.length, 5);
      const recovered = f.packets[4];
      assert.equal(recovered[1], version); assert.equal(recovered[4], 0);
      assert.equal(recovered[8], control === 'loss' ? 1 : 0);
      assert.equal(recovered[9], control === 'retirement' ? 1 : 0);
      assert.equal(recovered[10], control === 'probe' ? 1 : 0);
      if (control === 'loss') {
        assert.equal(recovered[32], 1); assert.equal(recovered[36], 1);
        assert.equal(recovered[34], 0); assert.equal(recovered[35], 1);
        assert.equal(recovered[39], 1);
      } else if (control === 'probe') assert.equal(recovered[128], 5);
      else {
        assert.equal(recovered[96], 1); assert.equal(recovered[97], recovered[3]);
        assert.equal(recovered[98], 0);
      }
    });
  }

  test('v' + version + ' disabled advanced-generation returns preserve pending loss probe and newly eligible retirement', () => {
    const f = fixture(version); f.bind(1); f.enqueue('current', 1, 8, 0.25); f.send({ type: 'play' });
    for (let probe = 1; probe <= 4; probe++) {
      f.render(1); f.send({ type: 'capture-probe', ownerSerial: 1, probe_id: probe });
    }
    f.send({ type: 'capture-unbind', ownerSerial: 1, bindingSerial: 1 });
    assert.deepEqual(Array.from(f.render(1)), [0.25]);
    f.send({ type: 'capture-probe', ownerSerial: 1, probe_id: 5 });
    f.send({ type: 'capture-disable', ownerSerial: 1 });
    f.send({ type: 'configure', generation: 2, sampleRate: 48000,
      currentCapacityFrames: 32, continuityCapacityFrames: 32, startupBufferFrames: 1 });
    assert.equal(f.packets.length, 4);
    const credit = f.packets[0];
    f.send({ type: 'capture-credit', generation: 1, ownerSerial: 1,
      bufferId: credit[12], buffer: credit.buffer.slice(0) });
    assert.equal(f.packets.length, 5);
    const recovered = f.packets[4];
    assert.equal(recovered[1], version); assert.equal(recovered[4], 0);
    assert.equal(recovered[8], 1); assert.equal(recovered[9], 1); assert.equal(recovered[10], 1);
    assert.equal(recovered[34], 4); assert.equal(recovered[35], 5); assert.equal(recovered[36], 1);
    assert.equal(recovered[96], 1); assert.equal(recovered[98], 5); assert.equal(recovered[128], 5);
    assert.equal(f.runs().reduce((sum, run) => sum + run.frames, 0), 4,
      'the missing fifth positive frame remains loss, never invented coverage');
    const next = f.packets[1];
    f.send({ type: 'capture-credit', generation: 1, ownerSerial: 1,
      bufferId: next[12], buffer: next.buffer.slice(0) });
    assert.equal(f.packets.length, 5, 'a fully drained disabled owner does not produce empty packets');
  });

  test('v' + version + ' explicit final-tail flushes remain immediate after a non-due credit return', () => {
    for (const terminal of ['pause', 'stop', 'capture-disable', 'seek-reset', 'ended']) {
      const f = fixture(version); f.bind(1);
      f.send({ type: 'capture-probe', ownerSerial: 1, probe_id: 1 });
      f.enqueue('current', 1, 4, 0.25); f.send({ type: 'play' }); f.render(4);
      const credit = f.packets[0];
      f.send({ type: 'capture-credit', ownerSerial: 1, bufferId: credit[12], buffer: credit.buffer.slice(0) });
      assert.equal(f.packets.length, 1, terminal + ': returned capacity is not a positive flush request');
      if (terminal === 'ended') {
        f.send({ type: 'eos', role: 'current', streamId: 1, emittedFrames: 4, authoritativeTotalFrames: 4 });
        assert.deepEqual(Array.from(f.render(1)), [0]);
      } else if (terminal === 'seek-reset') {
        f.send({ type: 'seek-reset', generation: 2, streamId: 2, timelineStartFrame: 100 });
      } else f.send({ type: terminal, ownerSerial: 1, reason: 'test-final-tail' });
      assert.equal(f.packets.length, 2, terminal + ': four-frame tail must be sent without waiting for 12000 frames');
      const tail = f.packets[1];
      assert.equal(tail[1], version); assert.equal(tail[4], 1);
      assert.equal(tail[258], 0); assert.equal(tail[259], 4);
      assert.equal(tail[260], 0); assert.equal(tail[261], 0);
      assert.equal(tail[8], 0); assert.equal(tail[9], 0); assert.equal(tail[10], 0);
    }
  });
}

for (const version of [1, 2]) {
  test('v' + version + ' the 256-run boundary remains forced after a non-due returned credit', () => {
    const f = fixture(version); f.bind(1);
    f.send({ type: 'capture-probe', ownerSerial: 1, probe_id: 1 });
    f.send({ type: 'play' });
    for (let index = 0; index < 255; index++) {
      f.send({ type: 'capture-epoch', ownerSerial: 1 });
      f.enqueue('current', 1, 1, 0.25, index);
      assert.deepEqual(Array.from(f.render(1)), [0.25]);
    }
    assert.equal(f.packets.length, 1);
    const credit = f.packets[0];
    f.send({ type: 'capture-credit', ownerSerial: 1, bufferId: credit[12], buffer: credit.buffer.slice(0) });
    assert.equal(f.packets.length, 1, '255 pending runs do not make an ordinary credit a flush request');
    f.send({ type: 'capture-epoch', ownerSerial: 1 });
    f.enqueue('current', 1, 1, 0.25, 255); f.render(1);
    assert.equal(f.packets.length, 2);
    assert.equal(f.packets[1][1], version); assert.equal(f.packets[1][4], 256);
    assert.equal(f.runs().length, 256); assert.ok(f.runs().every(run => run.frames === 1));
    f.send({ type: 'capture-epoch', ownerSerial: 1 });
    f.enqueue('current', 1, 1, 0.25, 256); f.render(1);
    assert.equal(f.packets.length, 2, 'the following positive frame starts a new retained batch');
    f.send({ type: 'pause' });
    assert.equal(f.packets.length, 3); assert.equal(f.packets[2][4], 1);
    assert.equal(f.packets[2][258], 256); assert.equal(f.packets[2][259], 1);
    assert.equal(f.runs().reduce((sum, run) => sum + run.frames, 0), 257);
  });
}
