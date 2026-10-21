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

test('credit starvation breaks continuity and retains explicit positive loss', () => {
  const f = fixture(); f.bind(1); f.enqueue('current', 1, 8, 0.25); f.send({ type: 'play' });
  for (let probe = 1; probe <= 4; probe++) {
    f.render(1); f.send({ type: 'capture-probe', ownerSerial: 1, probe_id: probe });
  }
  assert.equal(f.packets.length, 4);
  const before = f.runs();
  assert.equal(before.length, 4);
  assert.ok(before.every(run => run.continuity === before[0].continuity));
  assert.deepEqual(Array.from(f.render(1)), [0.25], 'capture starvation does not mute actual PCM');
  const returnCredit = packet => f.send({ type: 'capture-credit', ownerSerial: 1,
    bufferId: packet[12], buffer: packet.buffer.slice(0) });
  returnCredit(f.packets[0]);
  const loss = f.packets[4];
  assert.equal(loss[4], 0); assert.equal(loss[8], 1);
  assert.equal(loss[32 + 4], 1, 'one actually rendered but uncaptured frame is explicit loss');
  returnCredit(f.packets[1]);
  f.render(1); f.send({ type: 'capture-probe', ownerSerial: 1, probe_id: 5 });
  const after = f.runs(), last = after[after.length - 1];
  assert.equal(after.length, 5);
  assert.equal(last.ordinal, 5); assert.equal(last.output, 5);
  assert.ok(last.continuity > before[0].continuity);
});

test('unbound PCM between safe EOS handovers cannot join captured endpoints', () => {
  const f = fixture(); f.bind(1); f.bind(3, 100);
  f.enqueue('current', 1, 2, 0.25); f.enqueue('continuity', 2, 2, 0.5);
  f.send({ type: 'eos', role: 'current', streamId: 1, emittedFrames: 2, authoritativeTotalFrames: 2 });
  f.send({ type: 'play' });
  assert.deepEqual(Array.from(f.render(4)), [0.25, 0.25, 0.5, 0.5]);
  f.send({ type: 'eos', role: 'current', streamId: 2, emittedFrames: 2, authoritativeTotalFrames: 2 });
  f.enqueue('continuity', 3, 2, 0.75);
  assert.deepEqual(Array.from(f.render(2)), [0.75, 0.75]);
  f.send({ type: 'pause' });
  const runs = f.runs();
  assert.deepEqual(runs.map(run => run.binding), [1, 3]);
  assert.deepEqual(runs.map(run => run.source), [0, 100]);
  assert.deepEqual(runs.map(run => run.ordinal), [0, 4]);
  assert.deepEqual(runs.map(run => run.output), [0, 4]);
  assert.ok(runs[1].continuity > runs[0].continuity);
});
