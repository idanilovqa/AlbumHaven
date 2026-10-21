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
