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

function loadProcessorModule() {
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
    sampleRate: 48_000,
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
} = {}) {
  const loaded = loadProcessorModule();
  loaded.context.sampleRate = sampleRate;
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
  fixture.send({
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
