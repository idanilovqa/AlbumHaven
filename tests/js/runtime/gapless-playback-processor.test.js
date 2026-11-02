const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const processorPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'audio-worklets',
  'gapless-playback-processor.js',
);

const PROCESSOR_NAME = 'album-haven-gapless-playback';
const QUANTUM_FRAMES = 128;

function loadProcessorModule({ sampleRate = 48_000 } = {}) {
  const registrations = [];
  const ports = [];
  const context = {
    AudioWorkletProcessor: class FakeAudioWorkletProcessor {
      constructor() {
        const events = [];
        this.port = {
          events,
          onmessage: null,
          postMessage(message) {
            events.push(structuredClone(message));
          },
        };
        ports.push(this.port);
      }
    },
    Float32Array,
    Math,
    Number,
    Object,
    currentTime: 0,
    registerProcessor(name, Processor) {
      registrations.push({ name, Processor });
    },
    sampleRate,
  };
  vm.createContext(context);
  const source = fs.readFileSync(processorPath, 'utf8');
  vm.runInContext(source, context, { filename: processorPath });
  return { context, ports, registrations };
}

function createProcessor({
  generation = 7,
  sampleRate = 48_000,
  currentCapacityFrames = 512,
  continuityCapacityFrames = 512,
  startupBufferFrames = 1,
  configureInitially = true,
} = {}) {
  const loaded = loadProcessorModule({ sampleRate });
  const registration = loaded.registrations.find(({ name }) => name === PROCESSOR_NAME);
  assert.ok(registration, `${PROCESSOR_NAME} must be registered`);
  const processor = new registration.Processor();
  const fixture = {
    ...loaded,
    generation,
    processor,
    port: processor.port,
    renderedFrames: 0,
    send(message) {
      assert.equal(typeof processor.port.onmessage, 'function');
      processor.port.onmessage({ data: message });
    },
    events(type) {
      return processor.port.events.filter((event) => event.type === type);
    },
  };
  if (configureInitially) fixture.send({
    type: 'configure',
    generation,
    sampleRate,
    currentCapacityFrames,
    continuityCapacityFrames,
    startupBufferFrames,
  });
  return fixture;
}

function stereoFrames(leftValues, rightValues = leftValues.map((value) => -value)) {
  assert.equal(leftValues.length, rightValues.length);
  const pcm = new Float32Array(leftValues.length * 2);
  for (let frame = 0; frame < leftValues.length; frame += 1) {
    pcm[frame * 2] = leftValues[frame];
    pcm[(frame * 2) + 1] = rightValues[frame];
  }
  return pcm;
}

function enqueue(fixture, {
  streamId,
  role,
  sequence,
  left,
  right,
  generation = fixture.generation,
  frameCount = left.length,
  pcm = stereoFrames(left, right),
}) {
  fixture.send({
    type: 'enqueue',
    generation,
    streamId,
    role,
    sequence,
    frameCount,
    pcm,
  });
}

function markEos(fixture, {
  streamId,
  role,
  emittedFrames,
  authoritativeTotalFrames = emittedFrames,
  generation = fixture.generation,
}) {
  fixture.send({
    type: 'eos',
    generation,
    streamId,
    role,
    emittedFrames,
    authoritativeTotalFrames,
  });
}

function renderQuantum(fixture) {
  const left = new Float32Array(QUANTUM_FRAMES);
  const right = new Float32Array(QUANTUM_FRAMES);
  fixture.context.currentTime = fixture.renderedFrames / fixture.context.sampleRate;
  assert.equal(fixture.processor.process([], [[left, right]]), true);
  fixture.renderedFrames += QUANTUM_FRAMES;
  return { left: [...left], right: [...right] };
}

function assertRenderedStereo(fixture, expectedLeft, expectedRight = expectedLeft.map((value) => -value)) {
  const rendered = renderQuantum(fixture);
  assert.deepEqual(rendered.left, expectedLeft);
  assert.deepEqual(rendered.right, expectedRight);
  return rendered;
}

function assertRenderedSilence(fixture) {
  const silence = Array(QUANTUM_FRAMES).fill(0);
  return assertRenderedStereo(fixture, silence, silence);
}

function assertRenderedNonSilentStereo(fixture) {
  const rendered = renderQuantum(fixture);
  assert.equal(rendered.left.length, QUANTUM_FRAMES);
  assert.equal(rendered.right.length, QUANTUM_FRAMES);
  assert.ok(rendered.left.every(Number.isFinite));
  assert.ok(rendered.right.every(Number.isFinite));
  assert.ok(rendered.left.some((sample) => sample !== 0));
  assert.ok(rendered.right.some((sample) => sample !== 0));
  return rendered;
}

function sequence(start, count, step = 1) {
  return Array.from({ length: count }, (_unused, index) => start + (index * step));
}

function play(fixture) {
  fixture.send({ type: 'play', generation: fixture.generation });
}

test('registers the worklet under the committed processor name', () => {
  const { registrations } = loadProcessorModule();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, PROCESSOR_NAME);
  assert.equal(typeof registrations[0].Processor, 'function');
});

test('renders the first current frame and reports its stable stream identity', () => {
  const fixture = createProcessor();
  const current = sequence(1 / 256, QUANTUM_FRAMES, 1 / 256);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: current });
  play(fixture);

  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left, current);
  assert.deepEqual(rendered.right, current.map((value) => -value));
  assert.deepEqual(fixture.events('first-frame'), [{
    type: 'first-frame',
    generation: 7,
    streamId: 41,
    renderedFrame: 0,
    contextTime: 0,
  }]);
  assert.equal(fixture.events('underrun').length, 0);
});

test('keeps configured ring capacities fixed and rejects an enqueue that cannot fit', () => {
  const fixture = createProcessor({ currentCapacityFrames: 4, continuityCapacityFrames: 4 });
  fixture.send({
    type: 'configure',
    generation: 7,
    sampleRate: 48_000,
    currentCapacityFrames: 8,
    continuityCapacityFrames: 8,
  });
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: [90, 91, 92, 93, 94],
  });
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: [1, 2, 3, 4],
  });
  play(fixture);

  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left.slice(0, 4), [1, 2, 3, 4]);
  assert.deepEqual(rendered.left.slice(4), Array(124).fill(0));
});

test('keeps original capacities when a newer generation requests larger rings', () => {
  const fixture = createProcessor({ currentCapacityFrames: 4, continuityCapacityFrames: 4 });
  fixture.send({
    type: 'configure',
    generation: 8,
    sampleRate: 48_000,
    currentCapacityFrames: 8,
    continuityCapacityFrames: 8,
  });
  fixture.generation = 8;
  enqueue(fixture, {
    streamId: 51,
    role: 'current',
    sequence: 0,
    left: [90, 91, 92, 93, 94],
  });
  enqueue(fixture, {
    streamId: 51,
    role: 'current',
    sequence: 0,
    left: [1, 2, 3, 4],
  });
  play(fixture);

  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left.slice(0, 4), [1, 2, 3, 4]);
  assert.deepEqual(rendered.left.slice(4), Array(124).fill(0));
  assert.deepEqual(fixture.events('first-frame'), [{
    type: 'first-frame',
    generation: 8,
    streamId: 51,
    renderedFrame: 0,
    contextTime: 0,
  }]);
});

test('zero-fills a partial quantum and reports the exact ordinary underrun', () => {
  const fixture = createProcessor();
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: sequence(1, 32),
  });
  play(fixture);

  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left.slice(0, 32), sequence(1, 32));
  assert.deepEqual(rendered.left.slice(32), Array(96).fill(0));
  assert.deepEqual(fixture.events('underrun'), [{
    type: 'underrun',
    generation: 7,
    streamId: 41,
    role: 'current',
    renderedFrame: 32,
    missingFrames: 96,
  }]);
});

test('startup silence is not an underrun until the current stream has rendered a first frame', () => {
  const fixture = createProcessor();
  play(fixture);

  assert.deepEqual(renderQuantum(fixture).left, Array(QUANTUM_FRAMES).fill(0));
  assert.equal(fixture.events('underrun').length, 0);

  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: sequence(1, QUANTUM_FRAMES),
  });
  assertRenderedStereo(fixture, sequence(1, QUANTUM_FRAMES));
  assertRenderedSilence(fixture);

  assert.equal(fixture.events('first-frame').length, 1);
  assert.equal(fixture.events('underrun').length, 1);
});

test('pause writes silence without consuming buffered PCM', () => {
  const fixture = createProcessor();
  const frames = sequence(1, QUANTUM_FRAMES);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: frames });
  play(fixture);
  fixture.send({ type: 'pause', generation: 7 });

  const paused = renderQuantum(fixture);
  assert.deepEqual(paused.left, Array(QUANTUM_FRAMES).fill(0));
  assert.equal(fixture.events('consumed').length, 0);
  assert.equal(fixture.events('underrun').length, 0);

  play(fixture);
  const resumed = renderQuantum(fixture);
  assert.deepEqual(resumed.left, frames);
});

test('reports consumption by stable stream and remaining buffered frames', () => {
  const fixture = createProcessor({ currentCapacityFrames: 256 });
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: sequence(1, 192),
  });
  play(fixture);

  assertRenderedStereo(fixture, sequence(1, QUANTUM_FRAMES));

  const [consumed] = fixture.events('consumed');
  assert.deepEqual({
    type: consumed.type,
    generation: consumed.generation,
    streamId: consumed.streamId,
    role: consumed.role,
    frames: consumed.frames,
    bufferedFrames: consumed.bufferedFrames,
  }, {
    type: 'consumed',
    generation: 7,
    streamId: 41,
    role: 'current',
    frames: 128,
    bufferedFrames: 64,
  });
  assert.equal(consumed.audible, false);
  assert.equal(consumed.finiteSamples, 256);
  assert.equal(consumed.nonZeroSamples, 256);
  assert.equal(consumed.peakSample, 128);
  assert.deepEqual(consumed.samples.slice(0, 4), [1, -1, 2, -2]);
});

test('preserves frame order when a sequence refill wraps the current ring', () => {
  const fixture = createProcessor({ currentCapacityFrames: 192 });
  const initial = sequence(1, 192);
  const refill = sequence(193, 128);
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: initial,
  });
  play(fixture);

  const first = renderQuantum(fixture);
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 1,
    left: refill,
  });
  const second = renderQuantum(fixture);

  assert.deepEqual(first.left, initial.slice(0, QUANTUM_FRAMES));
  assert.deepEqual(second.left, [
    ...initial.slice(QUANTUM_FRAMES),
    ...refill.slice(0, 64),
  ]);
  assert.equal(new Set([...first.left, ...second.left]).size, 256);
  assert.equal(fixture.events('underrun').length, 0);
});

test('a generation reset drops buffered PCM and rejects stale enqueues', () => {
  const fixture = createProcessor();
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: Array(128).fill(1) });
  fixture.send({
    type: 'configure',
    generation: 8,
    sampleRate: 48_000,
    currentCapacityFrames: 512,
    continuityCapacityFrames: 512,
  });
  fixture.generation = 8;
  enqueue(fixture, {
    generation: 7,
    streamId: 41,
    role: 'current',
    sequence: 1,
    left: Array(128).fill(2),
  });
  enqueue(fixture, {
    generation: 8,
    streamId: 51,
    role: 'current',
    sequence: 0,
    left: Array(128).fill(3),
  });
  play(fixture);

  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(3));
  assert.equal(fixture.events('first-frame')[0].streamId, 51);
});

test('seek-reset starts a new generation at its requested timeline frame', () => {
  const fixture = createProcessor();
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: Array(128).fill(1) });
  fixture.send({
    type: 'seek-reset',
    generation: 8,
    streamId: 51,
    timelineStartFrame: 1_234,
  });
  fixture.generation = 8;
  enqueue(fixture, {
    generation: 7,
    streamId: 41,
    role: 'current',
    sequence: 1,
    left: Array(128).fill(2),
  });
  enqueue(fixture, {
    generation: 8,
    streamId: 51,
    role: 'current',
    sequence: 0,
    left: Array(128).fill(3),
  });
  play(fixture);

  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(3));
  assert.deepEqual(fixture.events('first-frame'), [{
    type: 'first-frame',
    generation: 8,
    streamId: 51,
    renderedFrame: 1_234,
    contextTime: 0,
  }]);
});

test('replacement generation discards every buffered sample from the prior track', () => {
  const fixture = createProcessor();
  enqueue(fixture, {
    streamId: 41, role: 'current', sequence: 0, left: Array(256).fill(0.75),
  });
  play(fixture);
  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(0.75));

  fixture.send({
    type: 'configure',
    generation: fixture.generation + 1,
    sampleRate: 48_000,
    currentCapacityFrames: 512,
    continuityCapacityFrames: 512,
  });
  fixture.generation += 1;
  play(fixture);
  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(0));

  enqueue(fixture, {
    streamId: 51, role: 'current', sequence: 0, left: Array(128).fill(-0.5),
  });
  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(-0.5));
});

test('prepared seek cuts over on the render clock without a silent frame', () => {
  const fixture = createProcessor({ currentCapacityFrames: 512, continuityCapacityFrames: 512 });
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: Array(256).fill(0.25),
  });
  play(fixture);
  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(0.25));

  enqueue(fixture, {
    streamId: 42,
    role: 'continuity',
    sequence: 0,
    left: Array(128).fill(-0.25),
  });
  fixture.send({
    type: 'prepare-seek',
    generation: fixture.generation,
    streamId: 42,
    timelineStartFrame: 144_000,
  });

  const rendered = renderQuantum(fixture);
  assert.deepEqual(rendered.left, Array(128).fill(-0.25));
  assert.equal(rendered.left.includes(0), false, 'the audible quantum contains no zero fill');
  assert.deepEqual(fixture.events('seek-boundary'), [{
    type: 'seek-boundary',
    generation: fixture.generation,
    outgoingStreamId: 41,
    incomingStreamId: 42,
    renderedFrame: 128,
    timelineFrame: 144_000,
    silentFrames: 0,
    capture: {
      outgoing: {
        frames: 64,
        left: new Float32Array(64).fill(0.25),
        right: new Float32Array(64).fill(-0.25),
      },
      incoming: {
        frames: 1,
        left: Float32Array.from({ length: 64 }, (_value, index) => (index === 0 ? -0.25 : 0)),
        right: Float32Array.from({ length: 64 }, (_value, index) => (index === 0 ? 0.25 : 0)),
      },
    },
  }]);
  assert.equal(fixture.events('underrun').length, 0);
  assert.equal(fixture.events('first-frame').at(-1).streamId, 42);
});

test('initial playback waits for its configured PCM cushion before rendering the first frame', () => {
  const fixture = createProcessor({ startupBufferFrames: QUANTUM_FRAMES * 2 });
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: Array(QUANTUM_FRAMES).fill(0.25),
  });
  play(fixture);

  assertRenderedSilence(fixture);
  assert.equal(fixture.events('first-frame').length, 0);
  assert.equal(fixture.events('underrun').length, 0);

  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 1,
    left: Array(QUANTUM_FRAMES).fill(0.5),
  });
  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left, Array(QUANTUM_FRAMES).fill(0.25));
  assert.equal(fixture.events('first-frame').length, 1);
  assert.equal(fixture.events('underrun').length, 0);
});

test('reserved seek retains the outgoing window from seek intent while preparation catches up', () => {
  const fixture = createProcessor({ currentCapacityFrames: 512, continuityCapacityFrames: 512 });
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: [
      ...Array(128).fill(0.125),
      ...Array(128).fill(-0.125),
    ],
  });
  play(fixture);
  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(0.125));

  fixture.send({
    type: 'reserve-seek',
    generation: fixture.generation,
    streamId: 42,
    timelineStartFrame: 144_000,
  });
  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(-0.125));

  enqueue(fixture, {
    streamId: 42,
    role: 'continuity',
    sequence: 0,
    left: Array(128).fill(-0.25),
  });
  fixture.send({
    type: 'prepare-seek',
    generation: fixture.generation,
    streamId: 42,
    timelineStartFrame: 144_000,
  });

  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(-0.25));
  const [boundary] = fixture.events('seek-boundary');
  assert.ok(boundary);
  assert.deepEqual(
    Array.from(boundary.capture.outgoing.left).slice(0, boundary.capture.outgoing.frames),
    Array(64).fill(0.125),
  );
});

test('reserved seek target cannot become an ordinary EOS handoff before it is prepared', () => {
  const fixture = createProcessor({ currentCapacityFrames: 512, continuityCapacityFrames: 512 });
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: Array(128).fill(0.25),
  });
  enqueue(fixture, {
    streamId: 42,
    role: 'continuity',
    sequence: 0,
    left: Array(128).fill(-0.25),
  });
  fixture.send({
    type: 'reserve-seek',
    generation: fixture.generation,
    streamId: 42,
    timelineStartFrame: 144_000,
  });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 128 });
  play(fixture);

  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(0.25));
  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(0));
  assert.equal(fixture.events('boundary').length, 0);
  assert.equal(fixture.events('ended').length, 0);

  fixture.send({
    type: 'prepare-seek',
    generation: fixture.generation,
    streamId: 42,
    timelineStartFrame: 144_000,
  });
  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(-0.25));
  assert.equal(fixture.events('seek-boundary').length, 1);
  assert.equal(fixture.events('boundary').length, 0);
});

test('renders current EOS and continuity consecutively in one process call', () => {
  const fixture = createProcessor();
  const outgoing = sequence(1, 64);
  const incoming = sequence(101, 64);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: outgoing });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: incoming });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 64 });
  play(fixture);

  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left, [...outgoing, ...incoming]);
  assert.deepEqual(rendered.right, [...outgoing, ...incoming].map((value) => -value));
  assert.equal(new Set(rendered.left).size, QUANTUM_FRAMES, 'no frame is duplicated');
  assert.equal(fixture.events('underrun').length, 0);
  assert.deepEqual(fixture.events('boundary').map((event) => ({
    outgoingStreamId: event.outgoingStreamId,
    incomingStreamId: event.incomingStreamId,
    renderedFrame: event.renderedFrame,
  })), [{ outgoingStreamId: 41, incomingStreamId: 42, renderedFrame: 64 }]);
  const [boundary] = fixture.events('boundary');
  assert.deepEqual(Array.from(boundary.capture.outgoing.left), outgoing);
  assert.deepEqual(Array.from(boundary.capture.outgoing.right), outgoing.map((value) => -value));
  assert.deepEqual(Array.from(boundary.capture.incoming.left), incoming);
  assert.deepEqual(Array.from(boundary.capture.incoming.right), incoming.map((value) => -value));
  assert.ok(boundary.capture.outgoing.left.length <= 64);
  assert.ok(boundary.capture.incoming.left.length <= 64);
});

test('renders three consecutive tracks across two same-quantum boundaries without silence', () => {
  const fixture = createProcessor();
  const first = sequence(1, 64);
  const second = sequence(101, 128);
  const third = sequence(301, 64);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: first });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: second });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: first.length });
  markEos(fixture, { streamId: 42, role: 'continuity', emittedFrames: second.length });
  play(fixture);

  const firstBoundaryQuantum = renderQuantum(fixture);
  enqueue(fixture, { streamId: 43, role: 'continuity', sequence: 0, left: third });
  markEos(fixture, { streamId: 43, role: 'continuity', emittedFrames: third.length });
  const secondBoundaryQuantum = renderQuantum(fixture);

  assert.deepEqual(firstBoundaryQuantum.left, [...first, ...second.slice(0, 64)]);
  assert.deepEqual(secondBoundaryQuantum.left, [...second.slice(64), ...third]);
  assert.deepEqual(fixture.events('boundary').map((event) => ({
    outgoingStreamId: event.outgoingStreamId,
    incomingStreamId: event.incomingStreamId,
    renderedFrame: event.renderedFrame,
  })), [
    { outgoingStreamId: 41, incomingStreamId: 42, renderedFrame: 64 },
    { outgoingStreamId: 42, incomingStreamId: 43, renderedFrame: 192 },
  ]);
  assert.equal(fixture.events('underrun').length, 0);
  assert.equal([...firstBoundaryQuantum.left, ...secondBoundaryQuantum.left].includes(0), false);
});

test('emits terminal ended once when current EOS drains without continuity', () => {
  const fixture = createProcessor();
  fixture.send({
    type: 'seek-reset',
    generation: 8,
    streamId: 51,
    timelineStartFrame: 1_234,
  });
  fixture.generation = 8;
  enqueue(fixture, {
    generation: 8,
    streamId: 51,
    role: 'current',
    sequence: 0,
    left: sequence(1, 64),
  });
  markEos(fixture, {
    generation: 8,
    streamId: 51,
    role: 'current',
    emittedFrames: 64,
  });
  play(fixture);

  const terminalQuantum = renderQuantum(fixture);
  assertRenderedSilence(fixture);

  assert.deepEqual(terminalQuantum.left.slice(0, 64), sequence(1, 64));
  assert.deepEqual(terminalQuantum.left.slice(64), Array(64).fill(0));
  assert.deepEqual(fixture.events('ended'), [{
    type: 'ended',
    generation: 8,
    streamId: 51,
    timelineFrame: 1_298,
  }]);
});

test('a near-end seek waits for its promised queued successor instead of stopping playback', () => {
  const fixture = createProcessor();
  enqueue(fixture, {
    streamId: 61,
    role: 'current',
    sequence: 0,
    left: sequence(1, 64),
  });
  markEos(fixture, { streamId: 61, role: 'current', emittedFrames: 64 });
  fixture.send({
    type: 'expect-continuity',
    generation: fixture.generation,
    active: true,
  });
  play(fixture);

  assertRenderedStereo(
    fixture,
    [...sequence(1, 64), ...Array(64).fill(0)],
    [...sequence(1, 64).map((value) => -value), ...Array(64).fill(0)],
  );
  assert.equal(fixture.events('underrun').length, 1);
  assert.equal(fixture.events('underrun')[0].missingFrames, 64);
  assert.equal(fixture.events('underrun')[0].renderedFrame, 64);
  assert.equal(fixture.events('ended').length, 0);
  assert.equal(fixture.processor.playing, true);

  enqueue(fixture, {
    streamId: 62,
    role: 'continuity',
    sequence: 0,
    left: sequence(101, 128),
  });
  const successorQuantum = renderQuantum(fixture);

  assert.deepEqual(successorQuantum.left, sequence(101, 128));
  assert.equal(fixture.events('boundary').length, 1);
  assert.equal(fixture.events('ended').length, 0);
});

test('cancelling a queued successor releases EOF only for the matching generation', () => {
  const fixture = createProcessor();
  enqueue(fixture, { streamId: 61, role: 'current', sequence: 0, left: sequence(1, 64) });
  markEos(fixture, { streamId: 61, role: 'current', emittedFrames: 64 });
  fixture.send({ type: 'expect-continuity', generation: fixture.generation, active: true });
  play(fixture);
  assertRenderedStereo(
    fixture,
    [...sequence(1, 64), ...Array(64).fill(0)],
    [...sequence(1, 64).map((value) => -value), ...Array(64).fill(0)],
  );
  assert.equal(fixture.events('ended').length, 0);
  fixture.send({ type: 'expect-continuity', generation: fixture.generation - 1, active: false });
  assertRenderedSilence(fixture);
  assert.equal(fixture.events('ended').length, 0, 'stale cancellation cannot release current EOF');
  fixture.send({ type: 'expect-continuity', generation: fixture.generation, active: false });
  assertRenderedSilence(fixture);
  assert.deepEqual(fixture.events('ended'), [{
    type: 'ended', generation: fixture.generation, streamId: 61, timelineFrame: 64,
  }]);
  assert.equal(fixture.processor.playing, false);
  assertRenderedSilence(fixture);
  assert.equal(fixture.events('ended').length, 1);
});

test('an expected empty successor releases terminal playback after its EOS arrives', () => {
  const fixture = createProcessor();
  enqueue(fixture, {
    streamId: 63,
    role: 'current',
    sequence: 0,
    left: sequence(1, 64),
  });
  markEos(fixture, { streamId: 63, role: 'current', emittedFrames: 64 });
  fixture.send({
    type: 'expect-continuity',
    generation: fixture.generation,
    active: true,
  });
  play(fixture);

  const outgoing = sequence(1, 64);
  const silence = Array(64).fill(0);
  assertRenderedStereo(
    fixture,
    [...outgoing, ...silence],
    [...outgoing.map((value) => -value), ...silence],
  );
  assert.equal(fixture.events('ended').length, 0);

  markEos(fixture, {
    streamId: 64,
    role: 'continuity',
    emittedFrames: 0,
    authoritativeTotalFrames: 0,
  });
  assertRenderedSilence(fixture);

  assert.equal(fixture.events('ended').length, 1);
  assert.equal(fixture.processor.playing, false);
});

test('continues the promoted stream with its next sequence under the current role', () => {
  const fixture = createProcessor();
  const outgoing = sequence(1, 64);
  const preparedHead = sequence(101, 64);
  const continuation = sequence(201, QUANTUM_FRAMES);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: outgoing });
  enqueue(fixture, {
    streamId: 42,
    role: 'continuity',
    sequence: 0,
    left: preparedHead,
  });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 64 });
  play(fixture);

  const boundaryQuantum = renderQuantum(fixture);
  enqueue(fixture, {
    streamId: 42,
    role: 'current',
    sequence: 1,
    left: continuation,
  });
  const continuedQuantum = renderQuantum(fixture);

  assert.deepEqual(boundaryQuantum.left, [...outgoing, ...preparedHead]);
  assert.deepEqual(continuedQuantum.left, continuation);
  assert.deepEqual(fixture.events('first-frame').map(({ streamId }) => streamId), [41, 42]);
  assert.deepEqual(fixture.events('boundary').map(({ outgoingStreamId, incomingStreamId }) => ({
    outgoingStreamId,
    incomingStreamId,
  })), [{ outgoingStreamId: 41, incomingStreamId: 42 }]);
  assert.equal(fixture.events('underrun').length, 0);
});

test('accepts exact zero-frame EOS as identity for a newly admitted empty continuity ring', () => {
  const fixture = createProcessor({ currentCapacityFrames: 64, continuityCapacityFrames: 64 });
  enqueue(fixture, {
    streamId: 41, role: 'current', sequence: 0, left: sequence(1, 64),
  });
  enqueue(fixture, {
    streamId: 42, role: 'continuity', sequence: 0, left: sequence(101, 64),
  });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 64 });
  play(fixture);
  assertRenderedStereo(fixture, [...sequence(1, 64), ...sequence(101, 64)]);

  assert.equal(fixture.processor.current.streamId, 42);
  assert.equal(fixture.processor.continuity.streamId, null);
  assert.equal(fixture.processor.continuity.receivedFrames, 0);

  markEos(fixture, {
    streamId: 43,
    role: 'continuity',
    emittedFrames: 0,
    authoritativeTotalFrames: 0,
  });

  assert.equal(fixture.events('protocol-reject').length, 0);
  assert.equal(fixture.processor.continuity.streamId, 43);
  assert.equal(fixture.processor.continuity.receivedFrames, 0);
  assert.equal(fixture.processor.continuity.eos, true);
  assert.equal(fixture.processor.continuity.emittedFrames, 0);
  assert.equal(fixture.processor.continuity.authoritativeTotalFrames, 0);
});

test('rejects exact zero-frame EOS identity binding for an unbound current ring', () => {
  const fixture = createProcessor({ currentCapacityFrames: 64, continuityCapacityFrames: 64 });

  markEos(fixture, {
    streamId: 42,
    role: 'current',
    emittedFrames: 0,
    authoritativeTotalFrames: 0,
  });

  assert.deepEqual(
    fixture.events('protocol-reject').map(({ operation, reason }) => ({ operation, reason })),
    [{ operation: 'eos', reason: 'identity' }],
  );
  assert.equal(fixture.processor.current.streamId, null);
  assert.equal(fixture.processor.current.eos, false);
});

test('rejects continuity zero-frame EOS identity already owned by the current ring', () => {
  const fixture = createProcessor({ currentCapacityFrames: 64, continuityCapacityFrames: 64 });
  enqueue(fixture, {
    streamId: 42, role: 'current', sequence: 0, left: [1],
  });

  markEos(fixture, {
    streamId: 42,
    role: 'continuity',
    emittedFrames: 0,
    authoritativeTotalFrames: 0,
  });

  assert.deepEqual(
    fixture.events('protocol-reject').map(({ operation, reason }) => ({ operation, reason })),
    [{ operation: 'eos', reason: 'identity' }],
  );
  assert.equal(fixture.processor.continuity.streamId, null);
  assert.equal(fixture.processor.continuity.eos, false);
});

test('keeps mismatched identity and invalid EOS frame accounting loud', () => {
  const fixture = createProcessor();
  enqueue(fixture, {
    streamId: 43, role: 'continuity', sequence: 0, left: [1],
  });

  markEos(fixture, {
    streamId: 44, role: 'continuity', emittedFrames: 0, authoritativeTotalFrames: 0,
  });
  markEos(fixture, {
    streamId: 43, role: 'continuity', emittedFrames: 0, authoritativeTotalFrames: 0,
  });
  markEos(fixture, {
    streamId: 43, role: 'continuity', emittedFrames: 1, authoritativeTotalFrames: 0,
  });

  assert.deepEqual(
    fixture.events('protocol-reject').map(({ operation, reason }) => ({ operation, reason })),
    [
      { operation: 'eos', reason: 'identity' },
      { operation: 'eos', reason: 'received-frames' },
      { operation: 'eos', reason: 'invalid-eos' },
    ],
  );
  assert.equal(fixture.processor.continuity.eos, false);
});

test('bounds boundary capture to the final 64 outgoing and first 64 incoming stereo frames', () => {
  const fixture = createProcessor({ currentCapacityFrames: 256, continuityCapacityFrames: 128 });
  const outgoing = sequence(1, 192);
  const incoming = sequence(301, 128);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: outgoing });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: incoming });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 192 });
  play(fixture);

  assertRenderedStereo(fixture, sequence(1, 128));
  const second = renderQuantum(fixture);
  const [boundary] = fixture.events('boundary');

  assert.deepEqual(second.left, [...outgoing.slice(128), ...incoming.slice(0, 64)]);
  assert.equal(boundary.renderedFrame, 192);
  assert.equal(boundary.capture.outgoing.left.length, 64);
  assert.equal(boundary.capture.outgoing.right.length, 64);
  assert.equal(boundary.capture.incoming.left.length, 64);
  assert.equal(boundary.capture.incoming.right.length, 64);
  assert.deepEqual(Array.from(boundary.capture.outgoing.left), outgoing.slice(-64));
  assert.deepEqual(Array.from(boundary.capture.incoming.left), incoming.slice(0, 64));
});

test('builds boundary capture from preallocated storage without render-time slicing', () => {
  const fixture = createProcessor();
  const outgoing = sequence(1, 64);
  const incoming = sequence(101, 64);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: outgoing });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: incoming });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 64 });
  fixture.processor.snapshotOutgoingCapture = () => {
    throw new Error('boundary rendering must not allocate an outgoing snapshot');
  };
  fixture.processor.boundaryIncomingLeft.slice = () => {
    throw new Error('boundary rendering must not slice incoming left capture');
  };
  fixture.processor.boundaryIncomingRight.slice = () => {
    throw new Error('boundary rendering must not slice incoming right capture');
  };
  play(fixture);

  const rendered = renderQuantum(fixture);
  const [boundary] = fixture.events('boundary');

  assert.deepEqual(rendered.left, [...outgoing, ...incoming]);
  assert.equal(boundary.capture.outgoing.frames, 64);
  assert.equal(boundary.capture.incoming.frames, 64);
  assert.equal(boundary.capture.outgoing.left.length, 64);
  assert.equal(boundary.capture.outgoing.right.length, 64);
  assert.equal(boundary.capture.incoming.left.length, 64);
  assert.equal(boundary.capture.incoming.right.length, 64);
  assert.deepEqual(Array.from(boundary.capture.outgoing.left), outgoing);
  assert.deepEqual(Array.from(boundary.capture.outgoing.right), outgoing.map((value) => -value));
  assert.deepEqual(Array.from(boundary.capture.incoming.left), incoming);
  assert.deepEqual(Array.from(boundary.capture.incoming.right), incoming.map((value) => -value));
});

test('rejects non-monotonic sequences without poisoning the next valid enqueue', () => {
  const fixture = createProcessor();
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2] });
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [90, 91] });
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 1, left: [3, 4] });
  play(fixture);

  assert.deepEqual(renderQuantum(fixture).left.slice(0, 4), [1, 2, 3, 4]);
});

test('rejects role conflicts and malformed enqueue fields', () => {
  const fixture = createProcessor();
  enqueue(fixture, { streamId: 99, role: 'next', sequence: 0, left: [89] });
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2] });
  enqueue(fixture, { streamId: 41, role: 'continuity', sequence: 0, left: [90] });
  enqueue(fixture, { streamId: 42, role: 'current', sequence: 0, left: [91] });
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 1,
    left: [92, 93],
    frameCount: 3,
  });
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 1, left: [3, 4] });
  play(fixture);

  assert.deepEqual(renderQuantum(fixture).left.slice(0, 4), [1, 2, 3, 4]);
});

test('retains and repeats a loop no longer than five seconds', () => {
  const fixture = createProcessor({
    sampleRate: 8_000,
    currentCapacityFrames: 16,
    continuityCapacityFrames: 40_000,
  });
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2, 3, 4] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: [5, 6, 7, 8] });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 4 });
  markEos(fixture, { streamId: 42, role: 'continuity', emittedFrames: 4 });
  fixture.send({
    type: 'set-loop',
    generation: 7,
    active: true,
    kind: 'short-loop',
    startFrame: 0,
    endFrame: 4,
    retainedStreamId: 42,
  });
  play(fixture);

  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left.slice(0, 20), [
    1, 2, 3, 4,
    5, 6, 7, 8,
    5, 6, 7, 8,
    5, 6, 7, 8,
    5, 6, 7, 8,
  ]);
  assert.equal(fixture.events('underrun').length, 0);
});

test('an exact five-second loop uses immutable circular storage', () => {
  const fixture = createProcessor({
    sampleRate: 8_000,
    currentCapacityFrames: 16,
    continuityCapacityFrames: 40_000,
  });
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2, 3, 4] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: [5, 6, 7, 8] });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 4 });
  markEos(fixture, { streamId: 42, role: 'continuity', emittedFrames: 4 });
  fixture.send({
    type: 'set-loop', generation: 7, active: true,
    kind: 'short-loop',
    startFrame: 0, endFrame: 40_000, retainedStreamId: 42,
  });
  assert.equal(fixture.processor.shortLoopActive, true, 'five seconds belongs to circular-loop policy');

  const retained = Array.from(fixture.processor.retainedLoopSamples.slice(0, 8));
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 1, left: [90, 91, 92, 93] });
  assert.deepEqual(
    Array.from(fixture.processor.retainedLoopSamples.slice(0, 8)),
    retained,
    'EOS loop storage cannot be mutated by a late decoder chunk',
  );
});

test('short circular replay emits an exact boundary for each audible wrap', () => {
  const fixture = createProcessor({
    sampleRate: 8_000,
    currentCapacityFrames: 16,
    continuityCapacityFrames: 40_000,
  });
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2, 3, 4] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: [5, 6, 7, 8] });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 4 });
  markEos(fixture, { streamId: 42, role: 'continuity', emittedFrames: 4 });
  fixture.send({
    type: 'set-loop', generation: 7, active: true,
    kind: 'short-loop',
    startFrame: 0, endFrame: 4, retainedStreamId: 42,
  });
  play(fixture);

  const rendered = renderQuantum(fixture);
  const boundaries = fixture.events('boundary').slice(0, 3).map((event) => ({
    outgoingStreamId: event.outgoingStreamId,
    incomingStreamId: event.incomingStreamId,
    renderedFrame: event.renderedFrame,
  }));

  assert.deepEqual(rendered.left.slice(0, 16), [
    1, 2, 3, 4, 5, 6, 7, 8, 5, 6, 7, 8, 5, 6, 7, 8,
  ]);
  assert.deepEqual(boundaries, [
    { outgoingStreamId: 41, incomingStreamId: 42, renderedFrame: 4 },
    { outgoingStreamId: 42, incomingStreamId: 42, renderedFrame: 8 },
    { outgoingStreamId: 42, incomingStreamId: 42, renderedFrame: 12 },
  ]);
  const retainedConsumption = fixture.events('consumed')
    .find((event) => event.streamId === 42 && event.audible === true);
  assert.ok(retainedConsumption, 'retained loop output reports exact audible sample evidence');
  assert.equal(retainedConsumption.frames, 124);
  assert.equal(retainedConsumption.nonZeroSamples, 248);
  assert.ok(retainedConsumption.peakSample > 0);
  assert.equal(fixture.events('underrun').length, 0);
});

test('reserves a short-loop stream before PCM arrives and retains monotonic chunks', () => {
  const fixture = createProcessor({
    sampleRate: 8_000,
    currentCapacityFrames: 16,
    continuityCapacityFrames: 40_000,
  });
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2, 3, 4] });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 4 });
  fixture.send({
    type: 'set-loop',
    generation: 7,
    active: true,
    kind: 'short-loop',
    startFrame: 0,
    endFrame: 4,
    retainedStreamId: 42,
  });
  enqueue(fixture, { streamId: 43, role: 'continuity', sequence: 0, left: [90] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: [5, 6] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 1, left: [7, 8] });
  markEos(fixture, { streamId: 42, role: 'continuity', emittedFrames: 4 });
  play(fixture);

  const first = renderQuantum(fixture);
  const second = renderQuantum(fixture);

  assert.deepEqual(first.left.slice(0, 20), [
    1, 2, 3, 4,
    5, 6, 7, 8,
    5, 6, 7, 8,
    5, 6, 7, 8,
    5, 6, 7, 8,
  ]);
  assert.deepEqual(second.left.slice(0, 16), [
    5, 6, 7, 8,
    5, 6, 7, 8,
    5, 6, 7, 8,
    5, 6, 7, 8,
  ]);
  assert.equal(fixture.events('underrun').length, 0);
});

test('disabling a prepared short loop releases continuity for an ordinary stream', () => {
  const fixture = createProcessor({
    sampleRate: 8_000,
    currentCapacityFrames: 16,
    continuityCapacityFrames: 40_000,
  });
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2, 3, 4] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: [5, 6, 7, 8] });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 4 });
  markEos(fixture, { streamId: 42, role: 'continuity', emittedFrames: 4 });
  fixture.send({
    type: 'set-loop',
    generation: 7,
    active: true,
    kind: 'short-loop',
    startFrame: 0,
    endFrame: 4,
    retainedStreamId: 42,
  });
  fixture.send({
    type: 'set-loop',
    generation: 7,
    active: false,
    startFrame: 0,
    endFrame: 4,
    retainedStreamId: 42,
  });
  enqueue(fixture, { streamId: 43, role: 'continuity', sequence: 0, left: [9, 10, 11, 12] });
  markEos(fixture, { streamId: 43, role: 'continuity', emittedFrames: 4 });
  play(fixture);

  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left.slice(0, 8), [1, 2, 3, 4, 9, 10, 11, 12]);
  assert.deepEqual(fixture.events('boundary').map(({ outgoingStreamId, incomingStreamId }) => ({
    outgoingStreamId,
    incomingStreamId,
  })), [{ outgoingStreamId: 41, incomingStreamId: 43 }]);
  assert.equal(fixture.events('underrun').length, 0);
});

test('promotes a prepared continuity stream for a loop longer than five seconds', () => {
  const fixture = createProcessor({ currentCapacityFrames: 64, continuityCapacityFrames: 64 });
  const outgoing = sequence(1, 64);
  const incoming = sequence(101, 64);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: outgoing });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: incoming });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 64 });
  fixture.send({
    type: 'set-loop',
    generation: 7,
    active: true,
    kind: 'long-loop',
    startFrame: 0,
    endFrame: 240_001,
    retainedStreamId: 42,
  });
  play(fixture);

  assert.deepEqual(renderQuantum(fixture).left, [...outgoing, ...incoming]);
  assert.deepEqual(fixture.events('boundary').map(({ outgoingStreamId, incomingStreamId }) => (
    { outgoingStreamId, incomingStreamId }
  )), [{ outgoingStreamId: 41, incomingStreamId: 42 }]);
  assert.equal(fixture.events('underrun').length, 0);
});

test('a long loop switches at its configured end frame before source EOS', () => {
  const fixture = createProcessor({
    sampleRate: 8_000,
    currentCapacityFrames: 128,
    continuityCapacityFrames: 128,
  });
  const outgoingPastLoopEnd = sequence(1, 128);
  const loopHead = sequence(201, 128);
  enqueue(fixture, {
    streamId: 41, role: 'current', sequence: 0, left: outgoingPastLoopEnd,
  });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: loopHead });
  fixture.processor.renderedFrames = 40_000;
  fixture.send({
    type: 'set-loop', generation: 7, active: true,
    kind: 'long-loop',
    startFrame: 0, endFrame: 40_001, retainedStreamId: 42,
  });
  play(fixture);

  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left, [outgoingPastLoopEnd[0], ...loopHead.slice(0, 127)]);
  assert.deepEqual(fixture.events('boundary').map(({
    outgoingStreamId, incomingStreamId, renderedFrame, timelineFrame,
  }) => ({ outgoingStreamId, incomingStreamId, renderedFrame, timelineFrame })), [{
    outgoingStreamId: 41, incomingStreamId: 42, renderedFrame: 40_001, timelineFrame: 127,
  }]);
  assert.equal(fixture.events('position').at(-1).timelineFrame, 127);
  assert.equal(fixture.events('underrun').length, 0);
});

test('a long loop holds its exact end frame when the prepared head is late', () => {
  const fixture = createProcessor({ currentCapacityFrames: 256, continuityCapacityFrames: 128 });
  enqueue(fixture, {
    streamId: 41, role: 'current', sequence: 0, left: sequence(1, 256),
  });
  play(fixture);
  assertRenderedStereo(fixture, sequence(1, QUANTUM_FRAMES));
  fixture.send({
    type: 'set-loop', generation: 7, active: true,
    kind: 'long-loop', startFrame: 0, endFrame: 128, retainedStreamId: 42,
  });

  const held = renderQuantum(fixture);

  assert.deepEqual(held.left, Array(QUANTUM_FRAMES).fill(0));
  assert.equal(fixture.processor.current.bufferedFrames, 128);
  assert.equal(fixture.processor.timelineFrame, 128);
  assert.deepEqual(fixture.events('underrun').slice(-1), [{
    type: 'underrun', generation: 7, streamId: 41, role: 'current',
    renderedFrame: 128, missingFrames: 128,
  }]);
});

test('disabling a short loop realigns its timeline to the audible source B point', () => {
  const fixture = createProcessor({
    sampleRate: 8_000, currentCapacityFrames: 16, continuityCapacityFrames: 40_000,
  });
  enqueue(fixture, {
    streamId: 41, role: 'current', sequence: 0, left: sequence(1, 12),
  });
  enqueue(fixture, {
    streamId: 42, role: 'continuity', sequence: 0, left: sequence(6, 5),
  });
  fixture.send({
    type: 'set-loop', generation: 7, active: true,
    kind: 'short-loop', startFrame: 5, endFrame: 10, retainedStreamId: 42,
  });
  play(fixture);
  assertRenderedNonSilentStereo(fixture);
  assert.notEqual(fixture.processor.timelineFrame, 10);

  fixture.send({
    type: 'set-loop', generation: 7, active: false,
    kind: 'short-loop', startFrame: 5, endFrame: 10, retainedStreamId: 42,
  });

  assert.equal(fixture.processor.timelineFrame, 10);
});

test('repreparing the same active long loop preserves its loop-local timeline cursor', () => {
  const fixture = createProcessor({
    sampleRate: 48_000,
    currentCapacityFrames: 128,
    continuityCapacityFrames: 128,
  });
  enqueue(fixture, { streamId: 42, role: 'current', sequence: 0, left: [1] });
  fixture.processor.loopActive = true;
  fixture.processor.loopKind = 'long-loop';
  fixture.processor.loopStartFrame = 48_000;
  fixture.processor.loopEndFrame = 336_000;
  fixture.processor.timelineFrame = 48_000;
  fixture.processor.renderedFrames = 336_000;
  enqueue(fixture, { streamId: 43, role: 'continuity', sequence: 0, left: [2] });

  fixture.send({
    type: 'set-loop', generation: 7, active: true,
    kind: 'long-loop', startFrame: 48_000, endFrame: 336_000, retainedStreamId: 43,
  });

  assert.equal(fixture.processor.timelineFrame, 48_000);
});

test('whole-track repeat promotes a frame-zero head without duplicating the boundary sample', () => {
  const fixture = createProcessor({ currentCapacityFrames: 64, continuityCapacityFrames: 64 });
  const ending = sequence(1, 64);
  const repeatHead = sequence(101, 64);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: ending });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: repeatHead });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 64 });
  fixture.send({
    type: 'set-loop', generation: 7, active: true,
    kind: 'whole-track-repeat',
    startFrame: 0, endFrame: 11_520_000, retainedStreamId: 42,
  });
  play(fixture);

  const rendered = renderQuantum(fixture);

  assert.deepEqual(rendered.left, [...ending, ...repeatHead]);
  assert.equal(rendered.left[63], 64);
  assert.equal(rendered.left[64], 101, 'the next audible sample is repeat frame zero');
  assert.deepEqual(fixture.events('boundary').map(({ outgoingStreamId, incomingStreamId, renderedFrame }) => ({
    outgoingStreamId, incomingStreamId, renderedFrame,
  })), [{ outgoingStreamId: 41, incomingStreamId: 42, renderedFrame: 64 }]);
  assert.equal(fixture.events('underrun').length, 0);
});

test('stop clears playback and reports the exact rendered position', () => {
  const fixture = createProcessor();
  enqueue(fixture, {
    streamId: 41,
    role: 'current',
    sequence: 0,
    left: Array(128).fill(1),
  });
  play(fixture);
  fixture.send({ type: 'stop', generation: 7, reason: 'ownership-lost' });

  assert.deepEqual(renderQuantum(fixture).left, Array(128).fill(0));
  assert.deepEqual(fixture.events('stopped'), [{
    type: 'stopped',
    generation: 7,
    reason: 'ownership-lost',
    renderedFrame: 0,
  }]);
  assert.equal(fixture.events('consumed').length, 0);
});


async function measuredProcessorReceiver(fixture, initialSeconds, t, {prewarm = false} = {}) {
  const track = {path:'/owned/terminal',src:'/owned/terminal',title:'Terminal',artist:'Artist',durationSeconds:200};
  const completions = [], requests = [], commands = [], nodes = [], sockets = [];
  class FiniteAudioContext {
    constructor() {this.sampleRate=48000;this.currentTime=0;this.state='suspended';this.destination={};this.audioWorklet={addModule:async()=>{}};}
    async resume() {if(this.state!=='closed')this.state='running';}
    async suspend() {if(this.state!=='closed')this.state='suspended';}
    async close() {this.state='closed';}
  }
  class ProcessorBridgeNode {
    constructor() {
      this.port={onmessage:null,postMessage(message) {commands.push(structuredClone(message));fixture.send(message);}};
      nodes.push(this);
    }
    connect(destination) {return destination;}
    disconnect() {}
  }
  class FiniteSocket {
    static OPEN=1;
    constructor() {this.readyState=1;this.sent=[];sockets.push(this);queueMicrotask(()=>this.onopen?.({}));}
    send(message) {this.sent.push(JSON.parse(message));}
    close() {this.readyState=3;this.onclose?.({code:1000});}
  }
  const window={AudioContext:FiniteAudioContext,WebSocket:FiniteSocket,location:{protocol:'http:',host:'measurement.test'},
    performance:{now:()=>1000,timeOrigin:1700000000000},setTimeout,clearTimeout};
  const c={window,console,crypto:require('node:crypto'),AudioContext:FiniteAudioContext,AudioWorkletNode:ProcessorBridgeNode,
    WebSocket:FiniteSocket,ArrayBuffer,DataView,Float32Array,TextDecoder,URL,performance:window.performance,
    queueMicrotask,setTimeout,clearTimeout,state:{player:{current:track,streaming:{mode:'stopped',generation:0,
      context:null,node:null,socket:null,roles:{current:null,continuity:null},limits:{currentSeconds:12,continuitySeconds:5},
      snapshot:{currentTime:0,duration:0,paused:true,ended:false,src:'',readyState:0},diagnostics:{firstFrameAtMs:0,
        bufferedFrames:{current:0,continuity:0},inFlightFrames:{current:0,continuity:0},underruns:0,staleMessages:0,activeRoles:[]}}}},
    isoNow:()=> '2026-09-09T12:00:00Z',unixNowSeconds:()=>1788955200,
    fetch:async(_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};}};
  c.getPlayerPlaybackSnapshot=()=>c.state.player.streaming.snapshot;
  vm.createContext(c);
  for(const name of ['player-streaming-engine.js','player-listen-session-helpers.js'])
    vm.runInContext(fs.readFileSync(path.join(path.dirname(processorPath),'../runtime',name),'utf8'),c);
  const observe=c.observeStreamingFacadeCallback;
  c.observeStreamingFacadeCallback=(result,...args)=>{if(result&&typeof result.then==='function')completions.push(result);return observe(result,...args);};
  t.after(async()=>{await c.stopStreamingPlayback('measurement-fixture-cleanup');await Promise.all(completions);});
  c.startListenSession(track);const session=c.state.player.listenSession;
  c.handleStreamingPlaybackEnded=()=>c.finalizeListenSession('ended',{session,skipCloseSegment:true,duration:200});
  assert.equal(fixture.processor.configured,false,'Real processor constructor has no prior configure');
  const role=await c.startStreamingTrack(track);
  assert.ok(role);assert.equal(c.state.player.streaming.roles.current,role);
  fixture.generation=role.generation;
  const configured=commands.findIndex(message=>message.type==='configure');
  const played=commands.findIndex(message=>message.type==='play');
  assert.ok(configured>=0&&played>configured,'Actual owner configure precedes actual causal PLAY');
  assert.equal(fixture.processor.configured,true);
  assert.equal(fixture.processor.generation,role.generation);
  assert.equal(fixture.processor.current.capacityFrames,commands[configured].currentCapacityFrames);
  assert.equal(fixture.processor.startupBufferFrames,commands[configured].startupBufferFrames);
  assert.equal(fixture.processor.playing,true);
  const causalPlay=commands[played];
  let delivered=0;
  function deliver() {
    while(delivered<fixture.port.events.length) nodes[0].port.onmessage({data:fixture.port.events[delivered++]});
  }
  let sequence=0;
  if(prewarm) {
    // Reach real startup via PCM, not a smaller configure or direct processor-state edit.
    const startupFrames=commands[configured].startupBufferFrames;
    assert.ok(Number.isInteger(startupFrames)&&startupFrames>0&&startupFrames<=48000);
    const frames=Math.ceil(startupFrames/QUANTUM_FRAMES)*QUANTUM_FRAMES;
    assert.ok(frames<=fixture.processor.current.capacityFrames);
    enqueue(fixture,{streamId:role.streamId,role:'current',sequence:sequence++,left:Array(frames).fill(0.25)});
    for(let offset=0;offset<frames;offset+=QUANTUM_FRAMES){renderQuantum(fixture);deliver();}
    assert.equal(fixture.processor.current.bufferedFrames,0);
    assert.equal(fixture.events('underrun').length,0);
    assert.equal(fixture.events('consumed').reduce((total,message)=>total+message.frames,0),frames);
    assert.ok(session.measurement.total>0);
  }
  // Preserve the pre-existing measurement starting totals, never playback authority.
  session.measurement.total=initialSeconds;session.measurement.contiguous=initialSeconds;session.measurement.longest=initialSeconds;
  return {c,session,requests,completions,role,sequence,causalPlay,deliver};
}

test('processor terminal quantum credits rendered frames through engine before finalizing measurement',async(t)=>{
  const fixture=createProcessor({configureInitially:false});const receiver=await measuredProcessorReceiver(fixture,10,t);
  enqueue(fixture,{streamId:receiver.role.streamId,role:'current',sequence:receiver.sequence,left:sequence(1,64)});
  markEos(fixture,{streamId:receiver.role.streamId,role:'current',emittedFrames:64});
  renderQuantum(fixture);receiver.deliver();await Promise.all(receiver.completions);
  assert.equal(fixture.events('ended')[0].playbackIntentId,receiver.causalPlay.playbackIntentId);
  assert.equal(receiver.session.measurement.total,10+64/48000);
  assert.equal(receiver.requests.length,1);assert.equal(receiver.requests[0].measured_listened_seconds,10.001);
});

test('processor partial underrun credits preceding frames before ending the measured contiguous segment',async(t)=>{
  const fixture=createProcessor({configureInitially:false});const receiver=await measuredProcessorReceiver(fixture,2,t,{prewarm:true});
  enqueue(fixture,{streamId:receiver.role.streamId,role:'current',sequence:receiver.sequence,left:sequence(1,32)});
  renderQuantum(fixture);receiver.deliver();
  assert.equal(receiver.session.measurement.total,2+32/48000);
  assert.equal(receiver.session.measurement.longest,2+32/48000);
  assert.equal(receiver.session.measurement.contiguous,0);
});


// App-reported position capture: separate from legacy rendered/consumed fields.
function enablePositionCapture(fixture) {
  Object.assign(fixture.context, { ArrayBuffer, Float64Array, currentFrame: fixture.renderedFrames });
  fixture.send({ type: 'capture-enable', ownerSerial: 1, generation: fixture.generation,
    sourceRate: 48000, outputRate: 48000,
    buffers: Array.from({ length: 4 }, () => new ArrayBuffer(16384)) });
}
function bindPositionCapture(fixture, streamId, sourceBase48 = 0, slot = 1, bindingSerial = slot) {
  fixture.send({ type: 'capture-bind', ownerSerial: 1, generation: fixture.generation,
    slot, bindingSerial, streamId, sourceBase48 });
}
function renderCapturedQuantum(fixture) {
  fixture.context.currentFrame = fixture.renderedFrames;
  return renderQuantum(fixture);
}
function positionPackets(fixture) {
  return fixture.events('capture-packet').map(event => new Float64Array(event.buffer));
}
function positionRuns(fixture) {
  return positionPackets(fixture).flatMap(data => Array.from({ length: data[4] }, (_, index) =>
    Array.from(data.slice(256 + index * 7, 263 + index * 7))));
}
function flushPositionCapture(fixture) {
  fixture.send({ type: 'pause', generation: fixture.generation });
}

test('capture preserves nonzero absolute source base and counts only successfully copied output', () => {
  const fixture = createProcessor();
  enablePositionCapture(fixture);
  bindPositionCapture(fixture, 41, 480000);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [0, 1, 2, 3] });
  play(fixture);
  const output = renderCapturedQuantum(fixture);
  flushPositionCapture(fixture);
  const runs = positionRuns(fixture);
  assert.deepEqual(output.left.slice(0, 4), [0, 1, 2, 3]);
  assert.equal(runs.reduce((sum, run) => sum + run[3], 0), 4);
  assert.equal(runs[0][2], 480000);
  assert.equal(runs[0][4], 0);
  assert.equal(runs[0][5], 0);
  assert.equal(fixture.processor.renderedFrames, 128);
});

test('capture follows actual prepared seek swap instead of requested seek time', () => {
  const fixture = createProcessor();
  enablePositionCapture(fixture);
  bindPositionCapture(fixture, 41, 1000);
  bindPositionCapture(fixture, 42, 96000, 2);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: Array(256).fill(1) });
  fixture.send({ type: 'reserve-seek', generation: 7, streamId: 42, timelineStartFrame: 96000 });
  play(fixture);
  renderCapturedQuantum(fixture);
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: Array(128).fill(2) });
  fixture.send({ type: 'prepare-seek', generation: 7, streamId: 42, timelineStartFrame: 96000 });
  const output = renderCapturedQuantum(fixture);
  flushPositionCapture(fixture);
  assert.ok(output.left.every(sample => sample === 2));
  const runs = positionRuns(fixture);
  assert.deepEqual(runs.map(run => [run[0], run[2], run[3], run[4], run[5]]),
    [[1, 1000, 128, 0, 0], [2, 96000, 128, 128, 128]]);
});

test('capture keeps many short wraps in one quantum without spending a credit per wrap', () => {
  const fixture = createProcessor({ currentCapacityFrames: 16, continuityCapacityFrames: 16 });
  enablePositionCapture(fixture);
  bindPositionCapture(fixture, 41, 0);
  bindPositionCapture(fixture, 42, 0, 2);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2, 3, 4] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: [5, 6, 7, 8] });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 4 });
  markEos(fixture, { streamId: 42, role: 'continuity', emittedFrames: 4 });
  fixture.send({ type: 'set-loop', generation: 7, active: true, kind: 'short-loop',
    startFrame: 0, endFrame: 4, retainedStreamId: 42 });
  play(fixture);
  const output = renderCapturedQuantum(fixture);
  flushPositionCapture(fixture);
  assert.deepEqual(output.left.slice(0, 12), [1, 2, 3, 4, 5, 6, 7, 8, 5, 6, 7, 8]);
  const runs = positionRuns(fixture);
  assert.equal(runs.length, 32);
  assert.equal(runs.reduce((sum, run) => sum + run[3], 0), 128);
  assert.ok(runs.slice(1).every(run => run[0] === 2 && run[2] === 0 && run[3] === 4));
  assert.equal(positionPackets(fixture).length, 1);
});

test('capture mixed-track quantum assigns each copied frame to its immutable stream binding', () => {
  const fixture = createProcessor();
  enablePositionCapture(fixture);
  bindPositionCapture(fixture, 41, 500);
  bindPositionCapture(fixture, 42, 900, 2);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: [3, 4] });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 2 });
  markEos(fixture, { streamId: 42, role: 'continuity', emittedFrames: 2 });
  play(fixture); renderCapturedQuantum(fixture); flushPositionCapture(fixture);
  assert.deepEqual(positionRuns(fixture).map(run => [run[0], run[2], run[3], run[5]]),
    [[1, 500, 2, 0], [2, 900, 2, 2]]);
});

test('four stalled capture buffers preserve mixed-epoch loss without allocating replacements', () => {
  const fixture = createProcessor({ currentCapacityFrames: 1024 });
  enablePositionCapture(fixture); bindPositionCapture(fixture, 41);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: Array(1024).fill(1) });
  for (let index = 0; index < 6; index++) {
    play(fixture); renderCapturedQuantum(fixture); flushPositionCapture(fixture);
  }
  assert.equal(positionPackets(fixture).length, 4);
  assert.equal(fixture.processor.positionCapture.outstanding, 4);
  assert.equal(fixture.processor.positionCapture.credits.length, 0);
  const first = positionPackets(fixture)[0], id = first[12];
  first.fill(0);
  fixture.send({ type: 'capture-credit', ownerSerial: 1, bufferId: id, buffer: first.buffer });
  const loss = positionPackets(fixture).at(-1);
  assert.equal(loss[8], 1);
  assert.equal(loss[33], 0, 'loss spanning pause/play epochs is explicitly unanchored');
  assert.equal(loss[36], 256);
  assert.equal(loss[34], 512);
  assert.equal(loss[35], 768);
  assert.equal(fixture.processor.positionCapture.outstanding, 4);
});

test('unbind waits for retained-loop emissions and acknowledges only through a credited packet', () => {
  const fixture = createProcessor({ currentCapacityFrames: 16, continuityCapacityFrames: 16 });
  enablePositionCapture(fixture); bindPositionCapture(fixture, 41); bindPositionCapture(fixture, 42, 0, 2);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2, 3, 4] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: [5, 6, 7, 8] });
  fixture.send({ type: 'set-loop', generation: 7, active: true, kind: 'short-loop',
    startFrame: 0, endFrame: 4, retainedStreamId: 42 });
  fixture.send({ type: 'capture-unbind', ownerSerial: 1, generation: 7, bindingSerial: 2 });
  assert.equal(positionPackets(fixture).length, 0);
  fixture.send({ type: 'set-loop', generation: 7, active: false });
  fixture.send({ type: 'capture-probe', ownerSerial: 1, generation: 7, probe_id: 1, epoch: 1 });
  const packet = positionPackets(fixture)[0];
  assert.equal(packet[9], 1);
  assert.equal(packet[96], 2);
  assert.equal(packet[97], packet[3]);
});

test('unsupported worklet rate disables only capture while PCM output remains unchanged', () => {
  const fixture = createProcessor({ sampleRate: 44100 });
  enablePositionCapture(fixture); bindPositionCapture(fixture, 41);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2, 3] });
  play(fixture);
  assert.deepEqual(renderCapturedQuantum(fixture).left.slice(0, 3), [1, 2, 3]);
  flushPositionCapture(fixture);
  assert.equal(positionPackets(fixture).length, 0);
});

test('retained fallback copy path uses loop absolute source instead of promoted ring cursor', () => {
  const fixture = createProcessor({ currentCapacityFrames: 16, continuityCapacityFrames: 16 });
  enablePositionCapture(fixture); bindPositionCapture(fixture, 41, 0); bindPositionCapture(fixture, 42, 10, 2);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1] });
  enqueue(fixture, { streamId: 42, role: 'continuity', sequence: 0, left: [5, 6, 7, 8] });
  markEos(fixture, { streamId: 41, role: 'current', emittedFrames: 1 });
  markEos(fixture, { streamId: 42, role: 'continuity', emittedFrames: 4 });
  fixture.send({ type: 'set-loop', generation: 7, active: true, kind: 'short-loop',
    startFrame: 10, endFrame: 14, retainedStreamId: 42 });
  play(fixture); renderCapturedQuantum(fixture); flushPositionCapture(fixture);
  const runs = positionRuns(fixture);
  assert.equal(runs.reduce((sum, run) => sum + run[3], 0), 128);
  assert.deepEqual(runs.slice(0, 3).map(run => [run[0], run[2], run[3], run[5]]),
    [[1, 0, 1, 0], [2, 10, 4, 1], [2, 10, 4, 5]]);
});

test('foreign or duplicate logical credit ID disables capture without a playback protocol rejection', () => {
  const fixture = createProcessor(); enablePositionCapture(fixture);
  fixture.send({ type: 'capture-credit', ownerSerial: 1, bufferId: 1, buffer: new ArrayBuffer(16384) });
  assert.equal(fixture.processor.positionCapture.enabled, false);
  assert.equal(fixture.events('protocol-reject').length, 0);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [3, 4] });
  play(fixture); assert.deepEqual(renderCapturedQuantum(fixture).left.slice(0, 2), [3, 4]);
});

test('capture transfers and returns the same logical credit with real ArrayBuffer detachment', () => {
  const fixture = createProcessor();
  fixture.port.postMessage = (message, transfer = []) => {
    fixture.port.events.push(structuredClone(message, { transfer }));
  };
  enablePositionCapture(fixture); bindPositionCapture(fixture, 41);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2] });
  play(fixture); renderCapturedQuantum(fixture); flushPositionCapture(fixture);
  const message = fixture.events('capture-packet')[0], data = new Float64Array(message.buffer), bufferId = data[12];
  assert.equal(fixture.processor.positionCapture.outstanding, 1);
  assert.equal(message.buffer.byteLength, 16384);
  data.fill(0);
  const returned = structuredClone({ type: 'capture-credit', ownerSerial: 1, bufferId, buffer: message.buffer }, { transfer: [message.buffer] });
  assert.equal(message.buffer.byteLength, 0);
  fixture.send(returned);
  assert.equal(fixture.processor.positionCapture.outstanding, 0);
  assert.equal(fixture.processor.positionCapture.credits.length, 4);
});

test('reused binding slot resets final ordinal before a zero-consumption cancellation', () => {
  const fixture = createProcessor(); enablePositionCapture(fixture); bindPositionCapture(fixture, 41);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2] });
  play(fixture); renderCapturedQuantum(fixture); flushPositionCapture(fixture);
  fixture.send({ type: 'capture-unbind', ownerSerial: 1, generation: 7, bindingSerial: 1 });
  const firstAck = positionPackets(fixture).find(packet => packet[9] && packet[96] === 1);
  assert.equal(firstAck[98], 2);
  bindPositionCapture(fixture, 42, 500, 1, 2);
  fixture.send({ type: 'capture-unbind', ownerSerial: 1, generation: 7, bindingSerial: 2 });
  const secondAck = positionPackets(fixture).find(packet => packet[9] && packet[96] === 2);
  assert.equal(secondAck[98], 0, 'new binding has never copied a positive frame');
  assert.equal(secondAck[8], 0, 'no summary counters leak from the retired binding');
});

test('fresh node admits retained engine owner before configure but rejects stale source bindings', () => {
  const loaded = loadProcessorModule();
  Object.assign(loaded.context, { ArrayBuffer, Float64Array, currentFrame: 0 });
  const Processor = loaded.registrations.find(item => item.name === PROCESSOR_NAME).Processor;
  const processor = new Processor();
  const fixture = { ...loaded, processor, port: processor.port, generation: 7, renderedFrames: 0,
    send(message) { processor.port.onmessage({ data: message }); },
    events(type) { return processor.port.events.filter(event => event.type === type); } };
  assert.equal(processor.generation, 0);
  enablePositionCapture(fixture); // Recreated node, already-resolved preparation context, retained engine generation7.
  assert.equal(processor.positionCapture.enabled, true);
  assert.equal(processor.positionCapture.credits.length, 4);
  fixture.send({ type: 'configure', generation: 7, sampleRate: 48000,
    currentCapacityFrames: 512, continuityCapacityFrames: 512, startupBufferFrames: 1 });
  fixture.send({ type: 'capture-bind', ownerSerial: 1, generation: 6,
    slot: 1, bindingSerial: 1, streamId: 41, sourceBase48: 999 });
  assert.equal(processor.positionCapture.slots[0].serial, 0);
  bindPositionCapture(fixture, 41, 123);
  enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left: [1, 2] });
  play(fixture); renderCapturedQuantum(fixture); flushPositionCapture(fixture);
  assert.deepEqual(positionRuns(fixture).map(run => [run[2], run[3]]), [[123, 2]]);
  fixture.send({ type: 'capture-enable', ownerSerial: 2, generation: 7,
    sourceRate: 48000, outputRate: 48000, buffers: Array.from({ length: 4 }, () => new ArrayBuffer(16384)) });
  assert.equal(processor.positionCapture.owner, 1, 'one-time admission never replaces the original port owner');
});

// Processor/command evidence only; this is not real-browser audible-playback proof.
test('empty warmup play is ignored by a genuinely unconfigured processor and configure remains paused', () => {
  const loaded = loadProcessorModule();
  const registration = loaded.registrations.find(({ name }) => name === PROCESSOR_NAME);
  assert.ok(registration);
  const processor = new registration.Processor();
  const fixture = { ...loaded, processor, renderedFrames: 0 };
  const send = message => processor.port.onmessage({ data: message });
  assert.equal(processor.configured, false);
  assertRenderedSilence(fixture);
  send({ type: 'play', generation: 0 });
  send({ type: 'play', generation: 0 });
  assert.equal(processor.configured, false);
  assert.equal(processor.playing, false);
  assertRenderedSilence(fixture);
  assert.deepEqual(processor.port.events, []);
  const configure = generation => send({
    type: 'configure', generation, sampleRate: 48000,
    currentCapacityFrames: 512, continuityCapacityFrames: 512, startupBufferFrames: 1,
  });
  configure(1);
  assert.equal(processor.configured, true);
  assert.equal(processor.playing, false);
  send({ type: 'enqueue', generation: 1, streamId: 1, role: 'current', sequence: 0,
    frameCount: 2, pcm: stereoFrames([0.25, 0.5]) });
  assertRenderedSilence(fixture);
  assert.equal(processor.port.events.some(event => event.type === 'first-frame'), false);
  send({ type: 'play', generation: 1 });
  assert.equal(processor.playing, true);
  configure(2);
  assert.equal(processor.playing, false, 'later legitimate configure resets prior playing state');
  assertRenderedSilence(fixture);
});

// Necessary clock invariant in the real processor VM, not browser/device,
// conversion-reference, capture coverage, or end-to-end gapless qualification.
for (const graphRate of [44_100, 48_000]) {
  test(`graph-rate invariant: matched ${graphRate} configure consumes exact stereo frames`, () => {
    const fixture = createProcessor({ sampleRate: graphRate });
    assert.equal(fixture.context.sampleRate, graphRate);
    assert.equal(fixture.processor.configured, true);
    assert.equal(fixture.processor.sampleRate, graphRate);
    const left = sequence(1 / 256, QUANTUM_FRAMES, 1 / 256);
    const right = sequence(-1 / 512, QUANTUM_FRAMES, -1 / 512);
    enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left, right });
    play(fixture);
    assertRenderedStereo(fixture, left, right);
    assert.equal(fixture.processor.renderedFrames, QUANTUM_FRAMES);
    assert.equal(fixture.processor.current.bufferedFrames, 0);
    assert.equal(fixture.events('consumed').reduce((frames, event) => frames + event.frames, 0), QUANTUM_FRAMES);
    assert.equal(fixture.events('first-frame').length, 1);
    assert.equal(fixture.events('underrun').length, 0);
  });

  const wrongRate = graphRate === 44_100 ? 48_000 : 44_100;
  test(`graph-rate invariant: actual ${graphRate} rejects initial configure ${wrongRate} before PCM allocation`, () => {
    const loaded = loadProcessorModule({ sampleRate: graphRate });
    const registration = loaded.registrations.find(({ name }) => name === PROCESSOR_NAME);
    assert.ok(registration);
    const processor = new registration.Processor();
    const fixture = { ...loaded, processor, renderedFrames: 0 };
    const send = message => processor.port.onmessage({ data: message });
    const current = processor.current, continuity = processor.continuity;
    const retained = processor.retainedLoopSamples;
    const allocations = [];
    // Observe only the finite typed-array allocation boundary after construction.
    // Processor configuration/state itself is changed solely through commands.
    loaded.context.Float32Array = class extends Float32Array {
      constructor(...args) { super(...args); allocations.push(this.length); }
    };
    send({ type: 'configure', generation: 7, sampleRate: wrongRate,
      currentCapacityFrames: 512, continuityCapacityFrames: 512, startupBufferFrames: 1 });
    assert.deepEqual(allocations, [], 'mismatch must not allocate playback PCM buffers');
    assert.strictEqual(processor.current, current);
    assert.strictEqual(processor.continuity, continuity);
    assert.strictEqual(processor.retainedLoopSamples, retained);
    assert.equal(processor.configured, false);
    assert.equal(processor.generation, 0);
    assert.equal(processor.sampleRate, 0);
    send({ type: 'enqueue', generation: 7, streamId: 41, role: 'current', sequence: 0,
      frameCount: 2, pcm: stereoFrames([0.25, 0.5]) });
    send({ type: 'play', generation: 7 });
    assert.equal(processor.playing, false);
    assert.equal(processor.current.bufferedFrames, 0);
    assertRenderedSilence(fixture);
    assert.equal(processor.renderedFrames, 0);
    assert.deepEqual(processor.port.events, [], 'no accepted PCM/first-frame/consumption evidence');
  });

  test(`graph-rate invariant: actual ${graphRate} retains accepted generation and PCM after newer ${wrongRate} configure`, () => {
    const fixture = createProcessor({ sampleRate: graphRate });
    const processor = fixture.processor;
    const current = processor.current, continuity = processor.continuity;
    const currentSamples = current.samples, continuitySamples = continuity.samples;
    const retained = processor.retainedLoopSamples;
    const left = sequence(1 / 256, 2 * QUANTUM_FRAMES, 1 / 256);
    const right = sequence(-1 / 512, 2 * QUANTUM_FRAMES, -1 / 512);
    enqueue(fixture, { streamId: 41, role: 'current', sequence: 0, left, right });
    play(fixture);
    assertRenderedStereo(fixture, left.slice(0, QUANTUM_FRAMES), right.slice(0, QUANTUM_FRAMES));
    assert.equal(processor.renderedFrames, QUANTUM_FRAMES);
    assert.equal(processor.timelineFrame, QUANTUM_FRAMES);
    assert.equal(processor.current.readFrame, QUANTUM_FRAMES);
    fixture.send({ type: 'configure', generation: 8, sampleRate: wrongRate,
      currentCapacityFrames: 1024, continuityCapacityFrames: 1024, startupBufferFrames: 128 });
    assert.equal(processor.generation, 7, 'rejected higher generation cannot replace the accepted owner');
    assert.equal(processor.sampleRate, graphRate);
    assert.equal(processor.renderedFrames, QUANTUM_FRAMES, 'rejected configure cannot rewind the rendered clock');
    assert.equal(processor.timelineFrame, QUANTUM_FRAMES, 'rejected configure cannot rewind the timeline');
    assert.equal(processor.current.readFrame, QUANTUM_FRAMES);
    assert.equal(processor.startupBufferFrames, 1);
    assert.equal(processor.playing, true);
    assert.strictEqual(processor.current, current);
    assert.strictEqual(processor.continuity, continuity);
    assert.strictEqual(processor.current.samples, currentSamples);
    assert.strictEqual(processor.continuity.samples, continuitySamples);
    assert.strictEqual(processor.retainedLoopSamples, retained);
    assert.equal(processor.current.streamId, 41);
    assert.equal(processor.current.bufferedFrames, QUANTUM_FRAMES);
    assert.equal(processor.current.nextSequence, 1);
    assertRenderedStereo(fixture, left.slice(QUANTUM_FRAMES), right.slice(QUANTUM_FRAMES));
    assert.equal(processor.renderedFrames, 2 * QUANTUM_FRAMES);
    assert.equal(processor.timelineFrame, 2 * QUANTUM_FRAMES);
    fixture.send({ type: 'configure', generation: 8, sampleRate: graphRate,
      currentCapacityFrames: 512, continuityCapacityFrames: 512, startupBufferFrames: 1 });
    assert.equal(processor.generation, 8, 'same next generation remains available for a valid command');
    assert.equal(processor.sampleRate, graphRate);
    assert.equal(processor.playing, false);
    assert.equal(processor.renderedFrames, 0, 'accepted next generation resets its own clock');
    assert.equal(processor.timelineFrame, 0);
    fixture.generation = 8;
    const next = sequence(1 / 512, QUANTUM_FRAMES, 1 / 512);
    enqueue(fixture, { streamId: 42, role: 'current', sequence: 0, left: next });
    play(fixture);
    assertRenderedStereo(fixture, next);
    assert.equal(processor.renderedFrames, QUANTUM_FRAMES);
  });
}

// E2a correlation: real processor command/output tests, not speaker/device proof.
test('E2a processor tags actual EOS and reemits retained EOS for a later play without extra consumed frames', () => {
  const fixture = createProcessor(); enablePositionCapture(fixture); bindPositionCapture(fixture, 41, 123456);
  enqueue(fixture, {streamId: 41, role: 'current', sequence: 0, left: [0.25, 0.5, 0.75, 1]});
  markEos(fixture, {streamId: 41, role: 'current', emittedFrames: 4});
  fixture.send({type: 'play', generation: 7, playbackIntentId: 1});
  const firstOutput = renderCapturedQuantum(fixture), first = fixture.events('ended')[0];
  assert.deepEqual(firstOutput.left.slice(0, 4), [0.25, 0.5, 0.75, 1]);
  assert.equal(first.playbackIntentId, 1);
  const before = {timeline: fixture.processor.timelineFrame, rendered: fixture.processor.renderedFrames,
    read: fixture.processor.current.readFrame, ordinal: fixture.processor.positionCapture.ordinal,
    consumed: fixture.events('consumed').reduce((sum, event) => sum + event.frames, 0)};
  fixture.send({type: 'pause', generation: 7, playbackIntentId: 2});
  fixture.send({type: 'play', generation: 7, playbackIntentId: 3});
  assert.equal(fixture.processor.renderedFrames, before.rendered, 'Control commands do not reset the graph clock');
  assertRenderedSilence(fixture);
  const latest = fixture.events('ended').at(-1);
  assert.equal(fixture.events('ended').length, 2); assert.equal(latest.playbackIntentId, 3);
  assert.equal(first.playbackIntentId, 1, 'A retained old notification keeps its causal token');
  assert.equal(latest.generation, first.generation); assert.equal(latest.streamId, first.streamId);
  assert.equal(latest.timelineFrame, first.timelineFrame);
  assert.equal(fixture.processor.timelineFrame, before.timeline); assert.equal(fixture.processor.current.readFrame, before.read);
  assert.equal(fixture.processor.positionCapture.ordinal, before.ordinal);
  assert.equal(fixture.events('consumed').reduce((sum, event) => sum + event.frames, 0), before.consumed);
});

for (const type of ['play', 'pause']) for (const bad of ['missing', 'null', 'zero', 'negative', 'fraction', 'unsafe', 'duplicate', 'regressing', 'string', 'boolean']) {
  test('E2a processor invalid correlated control has no play or capture effect: ' + type + '/' + bad, () => {
    const fixture = createProcessor(); enablePositionCapture(fixture); bindPositionCapture(fixture, 41);
    enqueue(fixture, {streamId: 41, role: 'current', sequence: 0, left: [1, 2, 3, 4]});
    fixture.send({type: 'play', generation: 7, playbackIntentId: 10});
    if (type === 'play') fixture.send({type: 'pause', generation: 7, playbackIntentId: 11});
    const latest = type === 'play' ? 11 : 10;
    const values = {null: null, zero: 0, negative: -1, fraction: 1.5, unsafe: Number.MAX_SAFE_INTEGER + 1,
      duplicate: latest, regressing: latest - 1, string: '12', boolean: true};
    const before = {playing: fixture.processor.playing, epoch: fixture.processor.positionCapture.epoch,
      ordinal: fixture.processor.positionCapture.ordinal, packets: fixture.events('capture-packet').length,
      read: fixture.processor.current.readFrame, buffered: fixture.processor.current.bufferedFrames};
    fixture.send({type, generation: 7, ...(bad === 'missing' ? {} : {playbackIntentId: values[bad]})});
    assert.equal(fixture.processor.playing, before.playing);
    assert.equal(fixture.processor.positionCapture.epoch, before.epoch);
    assert.equal(fixture.processor.positionCapture.ordinal, before.ordinal);
    assert.equal(fixture.events('capture-packet').length, before.packets);
    assert.equal(fixture.processor.current.readFrame, before.read); assert.equal(fixture.processor.current.bufferedFrames, before.buffered);
    markEos(fixture, {streamId: 41, role: 'current', emittedFrames: 4});
    fixture.send({type: 'play', generation: 7, playbackIntentId: 12}); renderCapturedQuantum(fixture);
    assert.equal(fixture.events('ended').at(-1).playbackIntentId, 12, 'Invalid commands did not consume the next valid token');
  });
}

test('E2a processor legacy control and EOS schema stay unchanged before correlation', () => {
  const fixture = createProcessor();
  enqueue(fixture, {streamId: 41, role: 'current', sequence: 0, left: [1]});
  markEos(fixture, {streamId: 41, role: 'current', emittedFrames: 1});
  play(fixture); renderQuantum(fixture);
  assert.deepEqual(fixture.events('ended')[0], {type: 'ended', generation: 7, streamId: 41, timelineFrame: 1});
  fixture.send({type: 'pause', generation: 7}); play(fixture); renderQuantum(fixture);
  assert.equal(fixture.events('ended').length, 2); assert.equal(Object.hasOwn(fixture.events('ended')[1], 'playbackIntentId'), false);
});

for (const reset of ['configure', 'seek-reset']) test('E2a processor generation reset drops correlation without accepting old lineage: ' + reset, () => {
  const fixture = createProcessor(); fixture.send({type: 'play', generation: 7, playbackIntentId: 50});
  if (reset === 'configure') fixture.send({type: 'configure', generation: 8, sampleRate: 48000,
    currentCapacityFrames: 512, continuityCapacityFrames: 512, startupBufferFrames: 1});
  else fixture.send({type: 'seek-reset', generation: 8, streamId: 42, timelineStartFrame: 0});
  fixture.generation = 8;
  fixture.send({type: 'play', generation: 7, playbackIntentId: 51});
  assert.equal(fixture.processor.playing, false);
  enqueue(fixture, {streamId: 42, role: 'current', sequence: 0, left: [1]});
  markEos(fixture, {streamId: 42, role: 'current', emittedFrames: 1});
  play(fixture); renderQuantum(fixture);
  assert.equal(Object.hasOwn(fixture.events('ended').at(-1), 'playbackIntentId'), false);
  fixture.send({type: 'play', generation: 8, playbackIntentId: 1}); renderQuantum(fixture);
  assert.equal(fixture.events('ended').at(-1).playbackIntentId, 1);
});

test('E2a processor accepts maximum safe intent and rejects overflow without wrapping', () => {
  const fixture = createProcessor(); enablePositionCapture(fixture);
  fixture.send({type: 'play', generation: 7, playbackIntentId: Number.MAX_SAFE_INTEGER});
  const epoch = fixture.processor.positionCapture.epoch;
  fixture.send({type: 'pause', generation: 7, playbackIntentId: Number.MAX_SAFE_INTEGER + 1});
  assert.equal(fixture.processor.playing, true); assert.equal(fixture.processor.positionCapture.epoch, epoch);
  enqueue(fixture, {streamId: 41, role: 'current', sequence: 0, left: [1]});
  markEos(fixture, {streamId: 41, role: 'current', emittedFrames: 1}); renderCapturedQuantum(fixture);
  assert.equal(fixture.events('ended').at(-1).playbackIntentId, Number.MAX_SAFE_INTEGER);
});


for (const type of ['play', 'pause']) for (const malformed of [null, 0, Number.MAX_SAFE_INTEGER + 1]) {
  test('E2a processor present malformed first token cannot enter legacy control: ' + type + '/' + String(malformed), () => {
    const fixture = createProcessor(); enablePositionCapture(fixture); bindPositionCapture(fixture, 41);
    if (type === 'pause') play(fixture); // Genuine legacy playing state, still no positive token.
    const before = {playing: fixture.processor.playing, epoch: fixture.processor.positionCapture.epoch,
      ordinal: fixture.processor.positionCapture.ordinal, packets: fixture.events('capture-packet').length};
    fixture.send({type, generation: 7, playbackIntentId: malformed});
    assert.equal(fixture.processor.playing, before.playing);
    assert.equal(fixture.processor.positionCapture.epoch, before.epoch);
    assert.equal(fixture.processor.positionCapture.ordinal, before.ordinal);
    assert.equal(fixture.events('capture-packet').length, before.packets);
    enqueue(fixture, {streamId: 41, role: 'current', sequence: 0, left: [1]});
    markEos(fixture, {streamId: 41, role: 'current', emittedFrames: 1});
    fixture.send({type: 'play', generation: 7, playbackIntentId: 1}); renderCapturedQuantum(fixture);
    assert.equal(fixture.events('ended').at(-1).playbackIntentId, 1);
  });
}
