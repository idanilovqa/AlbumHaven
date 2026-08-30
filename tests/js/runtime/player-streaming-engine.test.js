const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const enginePath = path.join(
  repoRoot,
  'music_app',
  'static',
  'js',
  'runtime',
  'player-streaming-engine.js',
);

function makeTrack(name = '01.flac') {
  return {
    path: `C:/Music/Album/${name}`,
    src: `/api/tracks/${encodeURIComponent(name)}`,
    durationSeconds: 240,
  };
}

function createPcmMessage({
  role = 0,
  generation = 1,
  streamId = 1,
  sequence = 0,
  samples = [0.25, -0.5, 0.75, -1],
} = {}) {
  const frameCount = samples.length / 2;
  const bytes = new ArrayBuffer(24 + (samples.length * 4));
  const view = new DataView(bytes);
  for (const [index, byte] of [...Buffer.from('AHPC')].entries()) {
    view.setUint8(index, byte);
  }
  view.setUint8(4, 1);
  view.setUint8(5, role);
  view.setUint16(6, 0, false);
  view.setUint32(8, generation, false);
  view.setUint32(12, streamId, false);
  view.setUint32(16, sequence, false);
  view.setUint32(20, frameCount, false);
  samples.forEach((sample, index) => view.setFloat32(24 + (index * 4), sample, true));
  return bytes;
}

function receivePcmAndAssertEnqueue(harness, messageOptions = {}, expectations = {}) {
  const samples = messageOptions.samples || [0.25, -0.5, 0.75, -1];
  const before = harness.portMessages('enqueue').length;
  const wirePcm = createPcmMessage({ ...messageOptions, samples });
  harness.sockets[0].receive(wirePcm);
  const enqueues = harness.portMessages('enqueue');
  const expectedEnqueue = expectations.expectedEnqueue !== false;
  assert.equal(
    enqueues.length,
    before + (expectedEnqueue ? 1 : 0),
    expectedEnqueue
      ? 'valid PCM must reach the worklet enqueue boundary'
      : 'rejected PCM must not reach the worklet enqueue boundary',
  );
  if (!expectedEnqueue) return null;

  const enqueue = enqueues.at(-1);
  const roleCode = Number(messageOptions.role || 0);
  assert.equal(enqueue.generation, Number(messageOptions.generation || 1));
  assert.equal(enqueue.streamId, Number(messageOptions.streamId || 1));
  assert.equal(enqueue.sequence, Number(messageOptions.sequence || 0));
  assert.equal(enqueue.role, expectations.role || (roleCode === 0 ? 'current' : 'continuity'));
  assert.equal(enqueue.frameCount, samples.length / 2);
  assert.deepEqual([...enqueue.pcm], [...new Float32Array(samples)]);
  assert.ok(samples.every(Number.isFinite), 'PCM evidence must contain only finite samples');
  assert.ok(samples.some((sample) => sample !== 0), 'PCM evidence must contain a non-silent sample');
  return enqueue;
}

function createEngineHarness(options = {}) {
  const sockets = [];
  const contexts = [];
  const nodes = [];
  let now = options.now ?? 1000;
  const timeOrigin = options.timeOrigin ?? 1_700_000_000_000;
  const dateNow = options.dateNow ?? Math.floor(timeOrigin + now);
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;

  class FakeDate extends Date {
    static now() {
      return dateNow;
    }
  }

  class FakeMessagePort {
    constructor() {
      this.messages = [];
      this.onmessage = null;
    }

    postMessage(message, transfer = []) {
      this.messages.push({ message, transfer });
      if (message.type === 'stop' && options.stopPostMessage) {
        options.stopPostMessage(message);
      }
    }

    dispatch(message) {
      this.onmessage?.({ data: message });
    }
  }

  class FakeAudioWorkletNode {
    constructor(context, name, nodeOptions) {
      this.context = context;
      this.name = name;
      this.options = nodeOptions;
      this.port = new FakeMessagePort();
      this.connections = [];
      this.disconnectCalls = 0;
      this.onprocessorerror = null;
      nodes.push(this);
    }

    connect(destination) {
      this.connections.push(destination);
      return destination;
    }

    disconnect() {
      this.disconnectCalls += 1;
      this.connections = [];
      if (options.disconnectNode) options.disconnectNode(this);
    }

    fail(error = new Error('processor failed')) {
      this.onprocessorerror?.({ error, message: error.message });
    }
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.sampleRate = 48_000;
      this.currentTime = options.contextTime ?? 12.5;
      this.destination = { kind: 'destination' };
      this.audioWorklet = {
        modules: [],
        addModule: async (url) => {
          this.audioWorklet.modules.push(url);
          if (options.addModule) await options.addModule(url);
        },
      };
      this.closeCalls = 0;
      this.resumeCalls = 0;
      contexts.push(this);
    }

    async resume() {
      this.resumeCalls += 1;
      if (options.resumeContext) await options.resumeContext(this);
      if (!options.resumeLeavesSuspended && this.state !== 'closed') this.state = 'running';
    }

    async suspend() {
      this.state = 'suspended';
    }

    async close() {
      this.closeCalls += 1;
      if (options.closeContext) await options.closeContext(this);
      this.state = 'closed';
    }
  }

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      this.binaryType = '';
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.closeCalls = 0;
      sockets.push(this);
      queueMicrotask(() => this.onopen?.({}));
    }

    send(message) {
      const parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;
      this.sent.push(parsedMessage);
      if (options.sendSocket) options.sendSocket(parsedMessage, this);
    }

    receive(message) {
      this.onmessage?.({ data: message instanceof ArrayBuffer ? message : JSON.stringify(message) });
    }

    receiveText(message) {
      this.onmessage?.({ data: String(message) });
    }

    fail(error = new Error('socket failed')) {
      this.onerror?.({ error, message: error.message });
    }

    unexpectedClose({ code = 1006, reason = 'connection lost' } = {}) {
      this.readyState = 3;
      this.onclose?.({ code, reason, wasClean: false });
    }

    close() {
      this.closeCalls += 1;
      if (options.closeSocket) options.closeSocket(this);
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  }

  const window = {
    AudioContext: FakeAudioContext,
    WebSocket: FakeWebSocket,
    location: { protocol: 'http:', host: 'album-haven.test' },
    performance: { now: () => now, timeOrigin },
    setTimeout: scheduleTimeout,
    clearTimeout: cancelTimeout,
  };
  if (Object.prototype.hasOwnProperty.call(options, 'runtimeAssetVersion')) {
    window.__ALBUM_HAVEN_RUNTIME_ASSET_VERSION__ = options.runtimeAssetVersion;
  }
  const context = {
    ArrayBuffer,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    Date: FakeDate,
    DataView,
    Float32Array,
    JSON,
    Math,
    MessagePort: FakeMessagePort,
    Promise,
    TextDecoder,
    URL,
    WebSocket: FakeWebSocket,
    clearTimeout: cancelTimeout,
    console,
    performance: window.performance,
    queueMicrotask,
    setTimeout: scheduleTimeout,
    state: {
      player: {
        streaming: {
          mode: 'stopped',
          generation: 0,
          context: null,
          node: null,
          socket: null,
          roles: { current: null, continuity: null },
          limits: { currentSeconds: 12, continuitySeconds: 5 },
          snapshot: {
            currentTime: 0,
            duration: 0,
            paused: true,
            ended: false,
            src: '',
            readyState: 0,
          },
          diagnostics: {
            firstFrameAtMs: 0,
            bufferedFrames: { current: 0, continuity: 0 },
            inFlightFrames: { current: 0, continuity: 0 },
            underruns: 0,
            staleMessages: 0,
            activeRoles: [],
            boundaryCapture: null,
          },
        },
      },
    },
    window,
    handleStreamingPlaybackFirstFrame: options.handleStreamingPlaybackFirstFrame,
    handleStreamingPlaybackBoundary: options.handleStreamingPlaybackBoundary,
    handleStreamingPlaybackPosition: options.handleStreamingPlaybackPosition,
    handleStreamingPlaybackEnded: options.handleStreamingPlaybackEnded,
    handleStreamingPlaybackWaveformReady: options.handleStreamingPlaybackWaveformReady,
    cancelWaveformPeakLoads: options.cancelWaveformPeakLoads,
    probeCachedWaveformPeaks: options.probeCachedWaveformPeaks,
  };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(enginePath, 'utf8'), context, { filename: enginePath });
  const api = vm.runInContext(`({
    prepare: prepareStreamingPlaybackEngine,
    start: startStreamingTrack,
    pause: pauseStreamingPlayback,
    resume: resumeStreamingPlayback,
    seek: seekStreamingPlayback,
    continuity: scheduleStreamingContinuity,
    setLoop: setStreamingLoop,
    stop: stopStreamingPlayback,
    snapshot: getStreamingPlaybackSnapshot,
  })`, context);

  return {
    api,
    contexts,
    dateNow: () => FakeDate.now(),
    engine: context.state.player.streaming,
    nodes,
    sockets,
    setNow(value) {
      now = value;
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    sent(type) {
      return sockets.flatMap((socket) => socket.sent).filter((message) => message.type === type);
    },
    portMessages(type) {
      return nodes.flatMap((node) => node.port.messages)
        .map(({ message }) => message)
        .filter((message) => message.type === type);
    },
  };
}

test('facade lifecycle hooks fire once for active first-frame and boundary messages only', async () => {
  const firstFrames = [];
  const boundaries = [];
  const harness = createEngineHarness({
    handleStreamingPlaybackFirstFrame: (event) => firstFrames.push(event),
    handleStreamingPlaybackBoundary: (event) => boundaries.push(event),
  });
  const outgoingTrack = { ...makeTrack(), durationSeconds: 1 };
  await harness.api.start(outgoingTrack);
  const current = harness.sent('open')[0];
  const firstFrame = {
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  };
  harness.nodes[0].port.dispatch(firstFrame);
  harness.nodes[0].port.dispatch(firstFrame);
  harness.nodes[0].port.dispatch({ ...firstFrame, generation: current.generation - 1 });
  harness.nodes[0].port.dispatch({ ...firstFrame, streamId: current.streamId + 999 });
  harness.sockets[0].receive({
    type: 'eos', generation: current.generation, streamId: current.streamId, role: 'current',
    emittedFrames: 144_000, authoritativeTotalFrames: 144_000,
  });

  await harness.api.continuity(makeTrack('02.flac'));
  const continuity = harness.sent('open')[1];
  const boundary = {
    type: 'boundary', generation: current.generation,
    outgoingStreamId: current.streamId, incomingStreamId: continuity.streamId,
    renderedFrame: 96_000, timelineFrame: 128, capture: {},
  };
  harness.nodes[0].port.dispatch(boundary);
  harness.nodes[0].port.dispatch(boundary);
  harness.nodes[0].port.dispatch({ ...boundary, generation: current.generation - 1 });
  harness.nodes[0].port.dispatch({ ...boundary, incomingStreamId: continuity.streamId + 999 });

  assert.equal(firstFrames.length, 1);
  assert.equal(boundaries.length, 1);
  assert.equal(
    boundaries[0].outgoingPlaybackSnapshot.currentTime,
    boundary.renderedFrame / 48_000,
    'the outgoing snapshot uses its rendered-frame clock, not the incoming post-promotion cursor',
  );
  assert.equal(
    boundaries[0].outgoingPlaybackSnapshot.duration,
    3,
    'the authoritative streaming duration replaces a stale provisional catalog duration',
  );
});

test('facade receives bounded position updates and one active terminal ended event', async () => {
  const positions = [];
  const ended = [];
  const harness = createEngineHarness({
    handleStreamingPlaybackPosition: (event) => positions.push(structuredClone(event)),
    handleStreamingPlaybackEnded: (event) => ended.push(structuredClone(event)),
  });
  const track = makeTrack();
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);

  const position = (timelineFrame, overrides = {}) => harness.nodes[0].port.dispatch({
    type: 'position',
    generation: current.generation,
    streamId: current.streamId,
    timelineFrame,
    ...overrides,
  });
  position(48_000);
  harness.setNow(1_100);
  position(52_800);
  harness.setNow(1_250);
  position(60_000);
  position(72_000, { generation: current.generation - 1 });
  position(72_000, { streamId: current.streamId + 999 });

  assert.deepEqual(positions, [
    {
      generation: current.generation,
      streamId: current.streamId,
      trackPath: track.path,
      timelineFrame: 48_000,
      currentTime: 1,
    },
    {
      generation: current.generation,
      streamId: current.streamId,
      trackPath: track.path,
      timelineFrame: 60_000,
      currentTime: 1.25,
    },
  ], 'position facade work is throttled to at most once every 250ms');

  const terminal = {
    type: 'ended',
    generation: current.generation,
    streamId: current.streamId,
    timelineFrame: 72_000,
  };
  harness.nodes[0].port.dispatch({ ...terminal, generation: current.generation - 1 });
  harness.nodes[0].port.dispatch({ ...terminal, streamId: current.streamId + 999 });
  harness.nodes[0].port.dispatch(terminal);
  harness.nodes[0].port.dispatch(terminal);

  assert.deepEqual(ended, [{
    generation: current.generation,
    streamId: current.streamId,
    trackPath: track.path,
    timelineFrame: 72_000,
    currentTime: 1.5,
  }]);
  assert.equal(harness.api.snapshot().currentTime, 1.5);
  assert.equal(harness.api.snapshot().paused, true);
  assert.equal(harness.api.snapshot().ended, true);
});

test('non-zero initial starts keep zero-relative worklet messages on the absolute track timeline', async () => {
  const positions = [];
  const ended = [];
  const harness = createEngineHarness({
    handleStreamingPlaybackPosition: (event) => positions.push(structuredClone(event)),
    handleStreamingPlaybackEnded: (event) => ended.push(structuredClone(event)),
  });
  const startSeconds = 3.11;
  const startFrame = Math.round(startSeconds * 48_000);
  await harness.api.start(makeTrack(), { startSeconds });
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);

  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  assert.equal(harness.api.snapshot().currentTime, startSeconds);
  assert.equal(harness.api.snapshot().renderedFrame, 0, 'rendered frames stay worklet-relative');
  assert.equal(
    harness.engine.roles.current.renderedFrameBase,
    0,
    'fresh current roles share the worklet-relative render-frame domain',
  );

  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    frames: 8_160,
    bufferedFrames: 0,
  });
  assert.equal(harness.api.snapshot().currentTime, (startFrame + 8_160) / 48_000);
  assert.equal(
    harness.api.snapshot().renderedFrame,
    8_160,
    'consumption keeps rendered frames zero-relative after an initial offset',
  );

  harness.nodes[0].port.dispatch({
    type: 'position',
    generation: current.generation,
    streamId: current.streamId,
    timelineFrame: 8_160,
  });
  assert.equal(harness.api.snapshot().currentTime, (startFrame + 8_160) / 48_000);
  assert.deepEqual(positions, [{
    generation: current.generation,
    streamId: current.streamId,
    trackPath: makeTrack().path,
    timelineFrame: startFrame + 8_160,
    currentTime: (startFrame + 8_160) / 48_000,
  }]);

  harness.nodes[0].port.dispatch({
    type: 'ended',
    generation: current.generation,
    streamId: current.streamId,
    timelineFrame: 48_000,
  });
  assert.deepEqual(ended, [{
    generation: current.generation,
    streamId: current.streamId,
    trackPath: makeTrack().path,
    timelineFrame: startFrame + 48_000,
    currentTime: (startFrame + 48_000) / 48_000,
  }]);
  assert.equal(harness.api.snapshot().currentTime, (startFrame + 48_000) / 48_000);
  assert.equal(harness.api.snapshot().renderedFrame, 48_000, 'terminal rendered frames stay worklet-relative');
  assert.equal(harness.api.snapshot().timelineStartFrame, startFrame);
});

test('a lagging position message cannot move current playback behind rendered consumption', async () => {
  const positions = [];
  const harness = createEngineHarness({
    handleStreamingPlaybackPosition: (event) => positions.push(structuredClone(event)),
  });
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);

  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    frames: 1_024,
    bufferedFrames: 0,
  });
  assert.equal(harness.api.snapshot().currentTime, 1_024 / 48_000);

  harness.nodes[0].port.dispatch({
    type: 'position',
    generation: current.generation,
    streamId: current.streamId,
    timelineFrame: 896,
  });

  assert.equal(
    harness.api.snapshot().currentTime,
    1_024 / 48_000,
    'a delayed worklet position sample must not make the visible playback clock run backward',
  );
  assert.equal(positions.at(-1)?.timelineFrame, 1_024);
  assert.equal(positions.at(-1)?.currentTime, 1_024 / 48_000);
});

test('waveform readiness survives playback refill dips and fires once per track identity', async () => {
  const ready = [];
  const cancelledGenerations = [];
  const harness = createEngineHarness({
    handleStreamingPlaybackWaveformReady: (event) => ready.push(event),
    cancelWaveformPeakLoads: (generation) => cancelledGenerations.push(generation),
  });
  const currentTrack = makeTrack('01.flac');
  const continuityTrack = makeTrack('02.flac');
  await harness.api.start(currentTrack);
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(0.125),
  });
  assert.equal(ready.length, 1, 'a current-only track starts compact waveform work promptly');
  assert.equal(ready[0].currentPath, currentTrack.path);
  assert.equal(ready[0].continuityPath, '');
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });

  await harness.api.continuity(continuityTrack);
  const continuity = harness.sent('open')[1];
  acceptMetadata(harness, continuity);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: continuity.generation,
    streamId: continuity.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(-0.125),
  });
  assert.equal(ready.length, 2, 'adding a ready successor refreshes the same current waveform identity');
  assert.equal(ready[1].generation, current.generation);
  assert.equal(ready[1].currentPath, currentTrack.path);
  assert.equal(ready[1].continuityPath, continuityTrack.path);

  harness.nodes[0].port.dispatch({
    type: 'consumed', generation: current.generation, streamId: current.streamId,
    role: 'current', frames: 24_000, bufferedFrames: 24_000,
  });
  assert.deepEqual(
    cancelledGenerations,
    [],
    'ordinary playback consumption must not abort and restart a long-running peak request',
  );
  assert.equal(ready.length, 2, 'the same identity remains active instead of restarting peak work');

  const nextCurrentTrack = makeTrack('new-generation.flac');
  const nextContinuityTrack = makeTrack('new-continuity.flac');
  await harness.api.stop('waveform-generation-test');
  await harness.api.start(nextCurrentTrack);
  assert.equal(ready.length, 2, 'a generation change does not reuse old readiness identities');

  const nextCurrent = harness.sent('open')[2];
  acceptMetadata(harness, nextCurrent);
  receivePcmAndAssertEnqueue(harness, {
    generation: nextCurrent.generation,
    streamId: nextCurrent.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  assert.equal(ready.length, 3);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: nextCurrent.generation, streamId: nextCurrent.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });
  await harness.api.continuity(nextContinuityTrack);
  const nextContinuity = harness.sent('open')[3];
  acceptMetadata(harness, nextContinuity);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: nextContinuity.generation,
    streamId: nextContinuity.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(-0.25),
  });

  assert.equal(ready.length, 4, 'a new current-plus-successor identity gets one readiness callback');
  assert.equal(ready[3].generation, nextCurrent.generation);
  assert.equal(ready[3].currentPath, nextCurrentTrack.path);
  assert.equal(ready[3].continuityPath, nextContinuityTrack.path);
});

test('current PCM ingress refills toward the configured waveform high water', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  assert.equal(harness.sent('credit').length, 1);
  assert.equal(harness.sent('credit')[0].frames, 48_000);

  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(0.125),
  });

  assert.equal(
    harness.sent('credit').length,
    2,
    'a legal current response must keep the decoder window full until current high water is buffered',
  );
  assert.equal(harness.sent('credit')[1].frames, 48_000);
});

test('a current-only track starts waveform loading after one protected second is committed', async () => {
  const ready = [];
  const harness = createEngineHarness({
    handleStreamingPlaybackWaveformReady: (event) => ready.push(event),
  });
  const track = makeTrack('final-track.flac');
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);

  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(0.125),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(ready)), [{
    generation: current.generation,
    currentPath: track.path,
    continuityPath: '',
  }]);
});

test('a finite short track reaches waveform readiness before its decoded tail is consumed', async () => {
  const ready = [];
  const harness = createEngineHarness({
    handleStreamingPlaybackWaveformReady: (event) => ready.push(event),
  });
  const track = makeTrack('four-second-track.flac');
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current, { provisionalTotalFrames: 4 * 48_000 });

  for (let sequence = 0; sequence < 3; sequence += 1) {
    receivePcmAndAssertEnqueue(harness, {
      generation: current.generation,
      streamId: current.streamId,
      sequence,
      samples: new Array(48_000 * 2).fill(0.125),
    });
    harness.nodes[0].port.dispatch({
      type: 'consumed',
      generation: current.generation,
      streamId: current.streamId,
      role: 'current',
      frames: 12_000,
      bufferedFrames: ((sequence + 1) * 48_000) - ((sequence + 1) * 12_000),
    });
  }

  assert.deepEqual(JSON.parse(JSON.stringify(ready)), [{
    generation: current.generation,
    currentPath: track.path,
    continuityPath: '',
  }]);
});

test('waveform readiness callback remains optional', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(0.125),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });
  await harness.api.continuity(makeTrack('02.flac'));
  const continuity = harness.sent('open')[1];
  acceptMetadata(harness, continuity);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: continuity.generation,
    streamId: continuity.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(-0.125),
  });
  assert.equal(harness.api.snapshot().generation, current.generation);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current', 'continuity']);
});

test('replacement, seek, and cleanup immediately cancel the stale waveform generation', async () => {
  const cancelledGenerations = [];
  const harness = createEngineHarness({
    cancelWaveformPeakLoads: (generation) => cancelledGenerations.push(generation),
  });
  await harness.api.start(makeTrack('first.flac'));
  const firstGeneration = harness.engine.generation;

  await harness.api.start(makeTrack('replacement.flac'));
  const replacementGeneration = harness.engine.generation;
  assert.deepEqual(cancelledGenerations, [firstGeneration]);

  await harness.api.seek(30);
  const seekGeneration = harness.engine.generation;
  assert.deepEqual(cancelledGenerations, [firstGeneration, replacementGeneration]);

  await harness.api.stop('test-cleanup');
  assert.deepEqual(
    cancelledGenerations,
    [firstGeneration, replacementGeneration, seekGeneration],
    'cleanup cancels optional work before discarding the active generation',
  );
});

test('an older start blocked on cleanup cannot replace a newer completed start', async () => {
  let releaseOlderStart;
  const olderBarrier = new Promise((resolve) => { releaseOlderStart = resolve; });
  const harness = createEngineHarness();
  const olderTrack = makeTrack('older.flac');
  const newerTrack = makeTrack('newer.flac');

  harness.engine.stopPromise = olderBarrier;
  const olderStart = harness.api.start(olderTrack);
  harness.engine.stopPromise = null;
  const newerRole = await harness.api.start(newerTrack);
  releaseOlderStart();
  const olderRole = await olderStart;

  const opens = harness.sent('open');
  assert.equal(olderRole, null);
  assert.equal(opens.length, 1);
  assert.equal(harness.sent('close').length, 0);
  assert.equal(opens[0].path, newerTrack.path);
  assert.strictEqual(harness.engine.roles.current, newerRole);
  assert.strictEqual(harness.engine.roles.current.track, newerTrack);
  assert.equal(harness.api.snapshot().src, newerTrack.src);
  assert.equal(harness.api.snapshot().generation, opens[0].generation);
  assert.equal(harness.engine.generation, opens[0].generation);
});

function acceptMetadata(harness, open, changes = {}) {
  harness.sockets[0].receive({
    type: 'metadata',
    generation: open.generation,
    streamId: open.streamId,
    role: open.role,
    sampleRate: 48_000,
    channels: 2,
    provisionalTotalFrames: 11_520_000,
    requestedStartFrame: open.startFrame,
    timelineStartFrame: open.startFrame,
    ...changes,
  });
}

test('prepares a suspended AudioContext, worklet, and socket without starting playback', async () => {
  const harness = createEngineHarness();

  await harness.api.prepare();
  await harness.settle();

  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.contexts[0].state, 'suspended');
  assert.deepEqual(
    harness.contexts[0].audioWorklet.modules,
    ['/static/js/audio-worklets/gapless-playback-processor.js'],
  );
  assert.equal(harness.nodes.length, 1);
  assert.equal(harness.nodes[0].name, 'album-haven-gapless-playback');
  assert.deepEqual(
    structuredClone(harness.nodes[0].options || {}),
    {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    },
  );
  assert.equal(harness.nodes[0].connections[0], harness.contexts[0].destination);
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.sockets[0].binaryType, 'arraybuffer');
  assert.equal(harness.api.snapshot().paused, true);
});

test('loads the AudioWorklet with the bootstrap runtime asset version', async () => {
  const harness = createEngineHarness({ runtimeAssetVersion: 'startup-runtime-digest' });

  await harness.api.prepare();
  await harness.settle();

  assert.deepEqual(
    harness.contexts[0].audioWorklet.modules,
    ['/static/js/audio-worklets/gapless-playback-processor.js?v=startup-runtime-digest'],
  );
});

test('resumes the prepared context only through the explicit user-gesture API', async () => {
  const harness = createEngineHarness();
  await harness.api.prepare();

  assert.equal(harness.contexts[0].state, 'suspended');
  await harness.api.resume();

  assert.equal(harness.contexts[0].state, 'running');
  assert.equal(harness.nodes[0].port.messages.at(-1).message.type, 'play');
});

test('records the worklet render clock when the first audible frame arrives', async () => {
  const harness = createEngineHarness({ contextTime: 21 });
  await harness.api.start(makeTrack());
  const open = harness.sent('open')[0];
  acceptMetadata(harness, open);
  receivePcmAndAssertEnqueue(harness, {
    generation: open.generation,
    streamId: open.streamId,
    samples: [0.25, -0.25, 0.5, -0.5],
  });

  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: open.generation,
    streamId: open.streamId,
    renderedFrame: 960,
    contextTime: 21.02,
  });

  const snapshot = harness.api.snapshot();
  assert.equal(snapshot.startedAtContextTime, 21.02);
  assert.equal(snapshot.renderedFrame, 960);
  assert.equal(snapshot.currentTime, 960 / snapshot.sampleRate);
});

test('records role opens and first-frame diagnostics on the browser monotonic clock', async () => {
  const timeOrigin = 1_700_000_000_000;
  const harness = createEngineHarness({
    now: 57.5,
    timeOrigin,
    dateNow: timeOrigin + 57,
  });
  await harness.api.start(makeTrack());
  const open = harness.sent('open')[0];

  harness.setNow(60.25);
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: open.generation,
    streamId: open.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.setNow(60.5);
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));

  const diagnostics = harness.api.snapshot().diagnostics;
  assert.equal(diagnostics.roleOpenedAtMs.current, 57.5);
  assert.equal(diagnostics.firstFrameAtMs, 60.25);
  assert.equal(diagnostics.roleOpenedAtMs.continuity, 60.5);
  assert.ok(diagnostics.roleOpenedAtMs.continuity >= diagnostics.firstFrameAtMs);
});

test('opens the raw track path while retaining the browser src in snapshots', async () => {
  const harness = createEngineHarness();
  const track = makeTrack('02.flac');

  await harness.api.start(track);

  const open = harness.sent('open')[0];
  assert.equal(open.path, track.path);
  assert.notEqual(open.path, track.src);
  assert.equal(harness.api.snapshot().src, track.src);
});

test('accepts required metadata and parses the 24-byte big-endian AHPC header with little-endian f32 PCM', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack(), { startSeconds: 0.5 });
  const open = harness.sent('open')[0];
  harness.sockets[0].receive({
    type: 'metadata',
    generation: open.generation,
    streamId: open.streamId,
    role: 'current',
    sampleRate: 48000,
    channels: 2,
    provisionalTotalFrames: 11520000,
    requestedStartFrame: 24000,
    timelineStartFrame: 24000,
  });

  receivePcmAndAssertEnqueue(harness, {
    generation: open.generation,
    streamId: open.streamId,
    sequence: 0,
  });

  const enqueue = harness.nodes[0].port.messages.find(({ message }) => message.type === 'enqueue');
  assert.equal(enqueue.message.generation, open.generation);
  assert.equal(enqueue.message.streamId, open.streamId);
  assert.equal(enqueue.message.sequence, 0);
  assert.equal(enqueue.message.frameCount, 2);
  assert.deepEqual([...enqueue.message.pcm], [0.25, -0.5, 0.75, -1]);
  assert.equal(enqueue.transfer.length, 1);
  assert.equal(harness.api.snapshot().requestedStartFrame, 24000);
  assert.equal(harness.api.snapshot().timelineStartFrame, 24000);
});

test('snapshot exposes bounded accepted current-stream PCM evidence without crediting stale frames', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('evidence.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  const acceptedSamples = Array.from({ length: 80 }, (_unused, index) => (
    index === 47 ? -0.875 : (index % 4 === 0 ? 0.25 : 0)
  ));

  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    sequence: 0,
    samples: acceptedSamples,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(harness.api.snapshot().diagnostics.pcmEvidence)), {
    generation: current.generation,
    streamId: current.streamId,
    frames: 40,
    finiteSamples: 80,
    nonZeroSamples: 21,
    peakSample: 0.875,
    samples: [...new Float32Array(acceptedSamples.slice(0, 32))],
  });
  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    frames: 40,
    bufferedFrames: 0,
    audible: false,
    finiteSamples: 80,
    nonZeroSamples: 21,
    peakSample: 0.875,
    samples: [...new Float32Array(acceptedSamples.slice(0, 32))],
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.api.snapshot().diagnostics.renderedPcmEvidence)),
    JSON.parse(JSON.stringify(harness.api.snapshot().diagnostics.pcmEvidence)),
  );

  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    sequence: 0,
    samples: [0.75, -0.75],
  }, { expectedEnqueue: false });
  assert.equal(harness.api.snapshot().diagnostics.pcmEvidence.frames, 40);
  assert.equal(harness.api.snapshot().diagnostics.pcmEvidence.nonZeroSamples, 21);
  assert.equal(harness.api.snapshot().diagnostics.pcmEvidence.samples.length, 32);
  assert.equal(harness.api.snapshot().diagnostics.renderedPcmEvidence.frames, 40);
});

test('current PCM evidence resets for a fresh current identity and follows promoted PCM only after promotion', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('first.flac'));
  const first = harness.sent('open')[0];
  acceptMetadata(harness, first);
  receivePcmAndAssertEnqueue(harness, {
    generation: first.generation,
    streamId: first.streamId,
    samples: [0.25, -0.25],
  });
  assert.equal(harness.api.snapshot().diagnostics.pcmEvidence.streamId, first.streamId);

  await harness.api.pause();
  const second = await harness.api.start(makeTrack('second.flac'));
  assert.deepEqual(JSON.parse(JSON.stringify(harness.api.snapshot().diagnostics.pcmEvidence)), {
    generation: second.generation,
    streamId: second.streamId,
    frames: 0,
    finiteSamples: 0,
    nonZeroSamples: 0,
    peakSample: 0,
    samples: [],
  });

  acceptMetadata(harness, second);
  receivePcmAndAssertEnqueue(harness, {
    generation: second.generation,
    streamId: second.streamId,
    samples: [0.5, -0.5],
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: second.generation, streamId: second.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  const continuityTrack = makeTrack('third.flac');
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(continuityTrack);
  const continuity = harness.sent('open').at(-1);
  acceptMetadata(harness, continuity);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: continuity.generation,
    streamId: continuity.streamId,
    samples: [0.75, -0.75],
  });
  assert.equal(harness.api.snapshot().diagnostics.pcmEvidence.streamId, second.streamId);

  harness.nodes[0].port.dispatch({
    type: 'boundary', generation: second.generation,
    outgoingStreamId: second.streamId, incomingStreamId: continuity.streamId,
    renderedFrame: 1, timelineFrame: 0,
    capture: { outgoing: { frames: 1 }, incoming: { frames: 1 } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.api.snapshot().diagnostics.pcmEvidence)), {
    generation: continuity.generation,
    streamId: continuity.streamId,
    frames: 1,
    finiteSamples: 2,
    nonZeroSamples: 2,
    peakSample: 0.75,
    samples: [0.75, -0.75],
  });
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: continuity.generation,
    streamId: continuity.streamId,
    sequence: 1,
    samples: [0.875, -0.875],
  }, { role: 'current' });
  assert.equal(harness.api.snapshot().diagnostics.pcmEvidence.frames, 2);
  assert.equal(harness.api.snapshot().diagnostics.pcmEvidence.peakSample, 0.875);
});

test('reserves credit across transport and worklet buffering while current ingress fills high water', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const open = harness.sent('open')[0];
  assert.equal(harness.portMessages('configure').at(-1).currentCapacityFrames, 12 * 48_000);
  assert.equal(harness.portMessages('configure').at(-1).continuityCapacityFrames, 5 * 48_000);
  acceptMetadata(harness, open);

  const initialCredits = harness.sent('credit');
  assert.ok(initialCredits.length > 0);
  assert.ok(initialCredits.every(({ frames }) => frames > 0 && frames <= 48_000));
  assert.ok(initialCredits.reduce((total, { frames }) => total + frames, 0) <= 48_000);

  receivePcmAndAssertEnqueue(harness, {
    generation: open.generation,
    streamId: open.streamId,
    samples: new Array(8_192).fill(0.25),
  });
  let snapshot = harness.api.snapshot();
  assert.ok(
    snapshot.diagnostics.inFlightFrames.current
      + snapshot.diagnostics.bufferedFrames.current <= 12 * 48_000,
  );

  const creditCount = harness.sent('credit').length;
  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: open.generation,
    streamId: open.streamId,
    role: 'current',
    frames: 2_048,
    bufferedFrames: 2_048,
  });
  snapshot = harness.api.snapshot();
  assert.equal(snapshot.diagnostics.bufferedFrames.current, 2_048);
  assert.equal(
    harness.sent('credit').length,
    creditCount,
    'consumption does not exceed the already reserved 48k transport window',
  );
  assert.ok(harness.sent('credit').at(-1).frames <= 48_000);
  assert.ok(
    snapshot.diagnostics.inFlightFrames.current
      + snapshot.diagnostics.bufferedFrames.current <= 12 * 48_000,
  );
});

test('a delayed consumed snapshot cannot erase newer PCM ingress and overfill the worklet ring', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);

  for (let sequence = 0; sequence < 2; sequence += 1) {
    receivePcmAndAssertEnqueue(harness, {
      generation: current.generation,
      streamId: current.streamId,
      sequence,
      samples: new Array(48_000 * 2).fill(0.25),
    });
  }
  assert.equal(harness.api.snapshot().diagnostics.bufferedFrames.current, 96_000);

  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    frames: 128,
    bufferedFrames: 47_872,
  });

  assert.equal(harness.api.snapshot().diagnostics.bufferedFrames.current, 95_872);
  const granted = harness.sent('credit')
    .filter(({ streamId }) => streamId === current.streamId)
    .reduce((total, { frames }) => total + frames, 0);
  assert.ok(granted <= (11 * 48_000) + 128);
});

test('ordinary queued continuity prepares a bounded three-second head before promotion', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('01.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    samples: new Array(128 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const continuity = harness.sent('open')[1];
  acceptMetadata(harness, continuity);

  const initialGranted = harness.sent('credit')
    .filter(({ streamId }) => streamId === continuity.streamId)
    .reduce((total, { frames }) => total + frames, 0);
  assert.equal(initialGranted, 48_000);

  for (let sequence = 0; sequence < 3; sequence += 1) {
    receivePcmAndAssertEnqueue(harness, {
      generation: continuity.generation,
      streamId: continuity.streamId,
      role: 1,
      sequence,
      samples: new Array(48_000 * 2).fill(0.25),
    });
  }

  const totalGranted = harness.sent('credit')
    .filter(({ streamId }) => streamId === continuity.streamId)
    .reduce((total, { frames }) => total + frames, 0);
  assert.equal(totalGranted, 3 * 48_000);
  assert.equal(harness.api.snapshot().diagnostics.bufferedFrames.continuity, 3 * 48_000);

  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: continuity.generation,
    streamId: continuity.streamId,
    role: 'continuity',
    frames: 128,
    bufferedFrames: 3_968,
  });
  const boundaryAdjacentGranted = harness.sent('credit')
    .filter(({ streamId }) => streamId === continuity.streamId)
    .reduce((total, { frames }) => total + frames, 0);
  assert.equal(boundaryAdjacentGranted, 3 * 48_000);
});

test('a subsecond short loop credits only its immutable loop window', async () => {
  const harness = createEngineHarness();
  const track = makeTrack('short-loop.flac');
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });
  await harness.api.continuity(track, {
    kind: 'short-loop', startSeconds: 1, endSeconds: 1.25,
  });
  const continuity = harness.sent('open')[1];
  acceptMetadata(harness, continuity);

  const granted = harness.sent('credit')
    .filter(({ streamId }) => streamId === continuity.streamId)
    .reduce((total, { frames }) => total + frames, 0);
  assert.equal(granted, 12_000);
});

test('drops stale generation, unknown stream, and non-monotonic PCM without poisoning the next sequence', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const open = harness.sent('open')[0];
  acceptMetadata(harness, open);

  const receive = (changes, expectedEnqueue = true) => receivePcmAndAssertEnqueue(harness, {
    generation: open.generation,
    streamId: open.streamId,
    ...changes,
  }, { expectedEnqueue });
  receive({ sequence: 0 });
  receive({ generation: open.generation - 1, sequence: 1 }, false);
  receive({ streamId: open.streamId + 99, sequence: 1 }, false);
  receive({ sequence: 0 }, false);
  receive({ sequence: 1 });

  assert.deepEqual(harness.portMessages('enqueue').map(({ sequence }) => sequence), [0, 1]);
  assert.equal(harness.api.snapshot().diagnostics.staleMessages, 3);
});

test('pause and explicit resume keep context, processor, and snapshot state aligned', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  await harness.api.pause();

  assert.equal(harness.contexts[0].state, 'suspended');
  assert.equal(harness.portMessages('pause').length, 1);
  assert.equal(harness.api.snapshot().paused, true);

  await harness.api.resume();
  assert.equal(harness.contexts[0].state, 'running');
  assert.equal(harness.portMessages('play').length, 2);
  assert.equal(harness.api.snapshot().paused, false);
});

test('resolved resume keeps playback paused while the AudioContext remains suspended', async () => {
  const harness = createEngineHarness({ resumeLeavesSuspended: true });
  await harness.api.prepare();

  await harness.api.resume();

  assert.equal(harness.contexts[0].state, 'suspended');
  assert.equal(harness.portMessages('play').length, 0);
  assert.equal(harness.api.snapshot().paused, true);
});

test('seek keeps the live generation and current role while preparing the target continuity head', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const continuity = harness.sent('open').at(-1);

  harness.setNow(1234.5);
  await harness.api.seek(30);

  const replacement = harness.sent('open').at(-1);
  assert.equal(replacement.generation, current.generation);
  assert.equal(replacement.role, 'continuity');
  assert.equal(replacement.startFrame, 30 * 48_000);
  assert.deepEqual(
    harness.sent('close').map(({ streamId, reason }) => ({ streamId, reason })),
    [
      { streamId: continuity.streamId, reason: 'seek-replaced' },
    ],
  );
  assert.equal(harness.engine.roles.current.streamId, current.streamId);
  assert.deepEqual({ ...harness.portMessages('drop-continuity').at(-1) }, {
    type: 'drop-continuity',
    generation: current.generation,
    streamId: continuity.streamId,
  });
  assert.equal(harness.portMessages('seek-reset').length, 0);
  assert.equal(
    harness.api.snapshot().diagnostics.seekRequestedAtMs,
    1234.5,
    'seek timing begins inside the engine at seek entry on the browser monotonic clock',
  );
});

test('prepared seek preserves playing versus paused state without resetting the worklet', async (t) => {
  for (const scenario of [
    { name: 'playing seek resumes replacement generation', pauseBeforeSeek: false },
    { name: 'paused seek remains paused until explicit resume', pauseBeforeSeek: true },
  ]) {
    await t.test(scenario.name, async () => {
      const harness = createEngineHarness();
      await harness.api.start(makeTrack());
      if (scenario.pauseBeforeSeek) await harness.api.pause();

      const messageOffset = harness.nodes[0].port.messages.length;
      await harness.api.seek(30);
      const seekMessages = harness.nodes[0].port.messages
        .slice(messageOffset)
        .map(({ message }) => ({ type: message.type, generation: message.generation }));

      assert.deepEqual(seekMessages, [
        { type: 'reserve-seek', generation: harness.engine.generation },
      ]);
      assert.equal(harness.api.snapshot().paused, scenario.pauseBeforeSeek);

      if (scenario.pauseBeforeSeek) {
        await harness.api.resume();
        assert.deepEqual(
          harness.nodes[0].port.messages.slice(messageOffset).map(({ message }) => ({
            type: message.type,
            generation: message.generation,
          })),
          [
            { type: 'reserve-seek', generation: harness.engine.generation },
            { type: 'play', generation: harness.engine.generation },
          ],
        );
      }
    });
  }
});

test('playing seek keeps current audible until a buffered continuity head commits', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('queued.flac'));
  const queued = harness.sent('open').at(-1);

  await harness.api.seek(3);
  const target = harness.sent('open').at(-1);
  assert.equal(target.generation, current.generation);
  assert.equal(target.role, 'continuity');
  assert.equal(target.startFrame, 144_000);
  assert.equal(harness.engine.roles.current.streamId, current.streamId);
  assert.deepEqual(
    harness.sent('close').map(({ streamId, reason }) => ({ streamId, reason })),
    [{ streamId: queued.streamId, reason: 'seek-replaced' }],
  );
  assert.equal(harness.portMessages('seek-reset').length, 0);
  assert.deepEqual({ ...harness.portMessages('reserve-seek').at(-1) }, {
    type: 'reserve-seek',
    generation: current.generation,
    streamId: target.streamId,
    timelineStartFrame: 144_000,
  });
  assert.equal(harness.portMessages('prepare-seek').length, 0);
  assert.equal(harness.engine.pendingContinuityTrack.path, 'C:/Music/Album/queued.flac');
  assert.equal(harness.api.snapshot().currentTime, 3, 'the requested position is visible immediately');
  harness.nodes[0].port.dispatch({
    type: 'position', generation: current.generation, streamId: current.streamId,
    timelineFrame: 24_000,
  });
  assert.equal(
    harness.api.snapshot().currentTime,
    3,
    'outgoing position reports cannot visually undo a pending seek click',
  );

  acceptMetadata(harness, target);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: target.generation,
    streamId: target.streamId,
    sequence: 0,
    samples: new Array(12_000 * 2).fill(0.25),
  });
  assert.deepEqual({ ...harness.portMessages('prepare-seek').at(-1) }, {
    type: 'prepare-seek',
    generation: current.generation,
    streamId: target.streamId,
    timelineStartFrame: 144_000,
  });

  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: current.generation,
    outgoingStreamId: current.streamId,
    incomingStreamId: target.streamId,
    renderedFrame: 128,
    timelineFrame: 144_000,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  assert.equal(harness.engine.roles.current.streamId, target.streamId);
  assert.equal(harness.engine.roles.continuity, null);
  assert.deepEqual(harness.sent('promote').at(-1), {
    type: 'promote', generation: current.generation, streamId: target.streamId,
    fromRole: 'continuity', toRole: 'current',
  });
  assert.equal(harness.sent('credit').at(-1).frames, 48_000);
  assert.equal(harness.api.snapshot().diagnostics.seekSilentFrames, 0);
  assert.equal(harness.api.snapshot().currentTime, 3);
  const staleBeforePromotedWirePcm = harness.api.snapshot().diagnostics.staleMessages;
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: target.generation,
    streamId: target.streamId,
    sequence: 1,
    samples: [0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4],
  }, { role: 'current' });
  assert.equal(harness.api.snapshot().diagnostics.staleMessages, staleBeforePromotedWirePcm);
  assert.equal(harness.portMessages('enqueue').at(-1).role, 'current');
  harness.sockets[0].receive({
    type: 'eos',
    generation: target.generation,
    streamId: target.streamId,
    role: 'continuity',
    emittedFrames: 12_004,
    authoritativeTotalFrames: 156_004,
  });
  assert.equal(
    harness.api.snapshot().duration,
    240,
    'a prepared seek tail must not redefine the established whole-track duration',
  );
  assert.equal(harness.api.snapshot().mode, 'playing');
  assert.equal(harness.portMessages('eos').at(-1).role, 'current');
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: target.streamId,
    renderedFrame: 128, contextTime: 2,
  });

  harness.sockets[0].receive({
    type: 'promoted', generation: current.generation, streamId: target.streamId, role: 'current',
  });
  await harness.settle();
  assert.equal(harness.sent('open').at(-1).path, 'C:/Music/Album/queued.flac');
  assert.equal(harness.sent('open').at(-1).role, 'continuity');
});

test('current EOS cannot replace an in-progress seek target with queued-next continuity', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current, { provisionalTotalFrames: 48_000 });
  receivePcmAndAssertEnqueue(harness, {
    role: 0,
    generation: current.generation,
    streamId: current.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });

  const queuedTrack = makeTrack('queued.flac');
  await harness.api.continuity(queuedTrack, { kind: 'queued-next', startSeconds: 0 });
  const queued = harness.sent('open').at(-1);

  await harness.api.seek(3);
  const target = harness.sent('open').at(-1);
  acceptMetadata(harness, target);
  assert.equal(target.role, 'continuity');
  assert.equal(target.startFrame, 144_000);
  assert.equal(harness.sent('close').at(-1).streamId, queued.streamId);
  assert.equal(harness.engine.pendingContinuityTrack, queuedTrack);
  assert.equal(harness.engine.pendingSeek.streamId, target.streamId);

  const openCountBeforeCurrentEos = harness.sent('open').length;
  const closeCountBeforeCurrentEos = harness.sent('close').length;
  harness.sockets[0].receive({
    type: 'eos',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    emittedFrames: 48_000,
    authoritativeTotalFrames: 48_000,
  });
  await harness.settle();

  assert.equal(
    harness.sent('open').length,
    openCountBeforeCurrentEos,
    'queued-next must not open while the seek target owns continuity',
  );
  assert.equal(
    harness.sent('close').length,
    closeCountBeforeCurrentEos,
    'current EOS must not close the in-progress seek target',
  );
  assert.equal(harness.engine.roles.current.streamId, current.streamId);
  assert.equal(harness.engine.roles.continuity.streamId, target.streamId);
  assert.equal(harness.engine.pendingSeek.currentStreamId, current.streamId);
  assert.equal(harness.engine.pendingSeek.streamId, target.streamId);
  assert.equal(harness.engine.pendingContinuityTrack, queuedTrack);

  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: target.generation,
    streamId: target.streamId,
    sequence: 0,
    samples: new Array(12_000 * 2).fill(-0.5),
  });
  assert.equal(harness.portMessages('prepare-seek').at(-1).streamId, target.streamId);
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: current.generation,
    outgoingStreamId: current.streamId,
    incomingStreamId: target.streamId,
    renderedFrame: 48_000,
    timelineFrame: 144_000,
    silentFrames: 0,
    capture: {
      outgoing: { frames: 64, left: new Float32Array(64).fill(0.25), right: new Float32Array(64).fill(0.25) },
      incoming: { frames: 1, left: new Float32Array([-0.5]), right: new Float32Array([-0.5]) },
    },
  });

  assert.equal(harness.engine.roles.current.streamId, target.streamId);
  assert.equal(harness.engine.pendingSeek, null);
  assert.equal(harness.api.snapshot().currentTime, 3);
  assert.equal(harness.api.snapshot().diagnostics.seekCapture.incoming.left[0], -0.5);
});

test('defers continuity scheduling until the current stream reports its first rendered frame', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];

  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  assert.equal(harness.sent('open').length, 1);

  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  await harness.settle();

  assert.equal(harness.sent('open').length, 2);
  assert.equal(harness.sent('open')[1].role, 'continuity');
});

test('uses a boundary to promote the stable server stream and waits for its ack before replacement continuity', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  assert.deepEqual({ ...harness.portMessages('configure').at(-1) }, {
    type: 'configure',
    generation: current.generation,
    sampleRate: 48_000,
    currentCapacityFrames: 12 * 48_000,
    continuityCapacityFrames: 5 * 48_000,
    startupBufferFrames: 12_000,
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const continuity = harness.sent('open')[1];
  await harness.api.continuity(makeTrack('03.flac'));

  harness.nodes[0].port.dispatch({
    type: 'boundary',
    generation: current.generation,
    outgoingStreamId: current.streamId,
    incomingStreamId: continuity.streamId,
    renderedFrame: 11_520_000,
    capture: { outgoing: { frames: 0 }, incoming: { frames: 1 } },
  });
  assert.deepEqual(harness.sent('promote'), [{
    type: 'promote',
    generation: current.generation,
    streamId: continuity.streamId,
    fromRole: 'continuity',
    toRole: 'current',
  }]);
  assert.equal(harness.engine.roles.current.streamId, continuity.streamId);
  assert.equal(harness.portMessages('configure').length, 1, 'promotion keeps the original bounded rings');
  assert.equal(harness.sent('open').length, 2, 'replacement waits for server acknowledgement');

  harness.sockets[0].receive({
    type: 'promoted',
    generation: current.generation,
    streamId: continuity.streamId + 100,
    role: 'current',
  });
  assert.equal(harness.sent('open').length, 2, 'mismatched acknowledgement is ignored');
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  harness.sockets[0].receive({
    type: 'promoted',
    generation: current.generation,
    streamId: continuity.streamId,
    role: 'current',
  });
  await harness.settle();

  assert.equal(harness.sent('open').length, 3);
  assert.equal(harness.sent('open')[2].role, 'continuity');
  assert.equal(harness.sent('open')[2].path, makeTrack('03.flac').path);

  harness.sockets[0].receive({
    type: 'promoted',
    generation: current.generation,
    streamId: continuity.streamId,
    role: 'current',
  });
  await harness.settle();
  assert.equal(harness.sent('open').length, 3, 'duplicate promotion acknowledgement is idempotent');
});

test('swapped physical rings keep promoted and replacement roles within their inherited capacities', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('01.flac'));
  const current = harness.sent('open')[0];
  assert.deepEqual({ ...harness.portMessages('configure').at(-1) }, {
    type: 'configure',
    generation: current.generation,
    sampleRate: 48_000,
    currentCapacityFrames: 12 * 48_000,
    continuityCapacityFrames: 5 * 48_000,
    startupBufferFrames: 12_000,
  });
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });

  const adjacentTrack = makeTrack('03.flac');
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(adjacentTrack);
  await harness.api.seek(10);
  const seekTarget = harness.sent('open').at(-1);
  acceptMetadata(harness, seekTarget);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: seekTarget.generation,
    streamId: seekTarget.streamId,
    sequence: 0,
    samples: new Array(12_000 * 2).fill(0.25),
  });

  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: current.generation,
    outgoingStreamId: current.streamId,
    incomingStreamId: seekTarget.streamId,
    renderedFrame: 128,
    timelineFrame: 10 * 48_000,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });

  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.engine.roles.current.streamId, seekTarget.streamId);
  assert.equal(harness.engine.roles.current.targetBufferFrames, 5 * 48_000);
  assert.deepEqual(harness.sent('promote').at(-1), {
    type: 'promote', generation: current.generation, streamId: seekTarget.streamId,
    fromRole: 'continuity', toRole: 'current',
  });

  for (let sequence = 1; sequence <= 5; sequence += 1) {
    receivePcmAndAssertEnqueue(harness, {
      role: 1,
      generation: seekTarget.generation,
      streamId: seekTarget.streamId,
      sequence,
      samples: new Array(48_000 * 2).fill(0.25),
    }, { role: 'current' });
    if (sequence === 1) {
      harness.nodes[0].port.dispatch({
        type: 'consumed',
        generation: seekTarget.generation,
        streamId: seekTarget.streamId,
        role: 'current',
        frames: 12_000,
        bufferedFrames: 48_000,
      });
    }
    const snapshot = harness.api.snapshot();
    assert.equal(snapshot.mode, 'playing');
    assert.equal(snapshot.diagnostics.lastProcessorReject, undefined);
    assert.ok(
      snapshot.diagnostics.bufferedFrames.current
        + snapshot.diagnostics.inFlightFrames.current <= 5 * 48_000,
      'promoted current credit must fit the inherited five-second physical ring',
    );
  }

  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  harness.sockets[0].receive({
    type: 'promoted', generation: current.generation, streamId: seekTarget.streamId, role: 'current',
  });
  await harness.settle();

  const replacementContinuity = harness.sent('open').at(-1);
  assert.equal(replacementContinuity.path, adjacentTrack.path);
  assert.equal(replacementContinuity.role, 'continuity');
  assert.equal(harness.engine.roles.current.streamId, seekTarget.streamId);
  assert.equal(harness.engine.roles.continuity.streamId, replacementContinuity.streamId);
  assert.ok(harness.engine.roles.continuity.targetBufferFrames <= 5 * 48_000);
  assert.equal(harness.sockets.length, 1);
});

test('active replacement prepares two buffered seconds while paused replacement keeps the clean fresh-current path', async (t) => {
  await t.test('active outgoing playback cannot cut over before the replacement head is protected', async () => {
    const harness = createEngineHarness();
    await harness.api.start(makeTrack('01.flac'));
    const outgoing = harness.sent('open')[0];
    acceptMetadata(harness, outgoing);
    receivePcmAndAssertEnqueue(harness, {
      generation: outgoing.generation,
      streamId: outgoing.streamId,
      samples: new Array(128 * 2).fill(0.25),
    });
    harness.nodes[0].port.dispatch({
      type: 'first-frame',
      generation: outgoing.generation,
      streamId: outgoing.streamId,
      renderedFrame: 0,
      contextTime: 12.5,
    });
    harness.engine.diagnostics.bufferedFrames.current = 48_000;

    assert.ok(
      harness.api.snapshot().diagnostics.inFlightFrames.current > 0,
      'the outgoing decoder still owns refill work when the active replacement begins',
    );

    const starting = harness.api.start(makeTrack('02.flac'));
    const replacement = harness.sent('open').at(-1);
    assert.equal(replacement.role, 'continuity');
    acceptMetadata(harness, replacement);

    const replacementCredits = harness.sent('credit')
      .filter(({ streamId }) => streamId === replacement.streamId);
    assert.equal(
      replacementCredits.reduce((frames, credit) => frames + credit.frames, 0),
      48_000,
      'active replacement starts with one bounded server credit window',
    );
    assert.equal(harness.engine.roles.continuity.targetBufferFrames, 2 * 48_000);

    receivePcmAndAssertEnqueue(harness, {
      role: 1,
      generation: replacement.generation,
      streamId: replacement.streamId,
      sequence: 0,
      samples: new Array(12_000 * 2).fill(0.5),
    });
    assert.equal(
      harness.portMessages('prepare-seek').length,
      0,
      'a quarter-second head must not make an actively selected track audible yet',
    );
    assert.equal(harness.engine.roles.current.streamId, outgoing.streamId);

    receivePcmAndAssertEnqueue(harness, {
      role: 1,
      generation: replacement.generation,
      streamId: replacement.streamId,
      sequence: 1,
      samples: new Array(36_000 * 2).fill(0.5),
    });
    assert.equal(
      harness.portMessages('prepare-seek').length,
      0,
      'the former one-second head must remain inaudible while protection is rebuilt',
    );

    receivePcmAndAssertEnqueue(harness, {
      role: 1,
      generation: replacement.generation,
      streamId: replacement.streamId,
      sequence: 2,
      samples: new Array(48_000 * 2).fill(0.5),
    });
    assert.deepEqual({ ...harness.portMessages('prepare-seek').at(-1) }, {
      type: 'prepare-seek',
      generation: replacement.generation,
      streamId: replacement.streamId,
      timelineStartFrame: 0,
    });
    assert.equal(typeof starting.then, 'function');
  });

  await t.test('paused outgoing playback still replaces through a fresh current stream', async () => {
    const harness = createEngineHarness();
    await harness.api.start(makeTrack('01.flac'));
    const outgoing = harness.sent('open')[0];
    harness.nodes[0].port.dispatch({
      type: 'first-frame',
      generation: outgoing.generation,
      streamId: outgoing.streamId,
      renderedFrame: 0,
      contextTime: 12.5,
    });
    await harness.api.pause();

    const replacement = await harness.api.start(makeTrack('02.flac'));
    assert.equal(replacement.role, 'current');
    assert.notEqual(replacement.generation, outgoing.generation);
    assert.equal(harness.engine.pendingSeek, null);
    assert.equal(harness.portMessages('reserve-seek').length, 0);
    assert.equal(harness.portMessages('prepare-seek').length, 0);

    acceptMetadata(harness, replacement);
    const replacementCredits = harness.sent('credit')
      .filter(({ streamId, generation }) => (
        streamId === replacement.streamId && generation === replacement.generation
      ));
    assert.equal(
      replacementCredits.reduce((frames, credit) => frames + credit.frames, 0),
      48_000,
    );
  });
});

test('replacement promotion waits for one actual buffered second before opening adjacent album continuity', async () => {
  const replacementTrack = makeTrack('03.flac');
  const adjacentTrack = makeTrack('04.flac');
  let adjacentRequest = null;
  let harness;
  harness = createEngineHarness({
    handleStreamingPlaybackFirstFrame: (event) => {
      if (event.trackPath !== replacementTrack.path) return null;
      adjacentRequest = harness.api.continuity(adjacentTrack, {
        kind: 'queued-next',
        startSeconds: 0,
      });
      return adjacentRequest;
    },
  });

  await harness.api.start(makeTrack('01.flac'));
  const initialCurrent = harness.sent('open')[0];
  acceptMetadata(harness, initialCurrent);
  receivePcmAndAssertEnqueue(harness, {
    generation: initialCurrent.generation,
    streamId: initialCurrent.streamId,
    samples: new Array(128 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: initialCurrent.generation,
    streamId: initialCurrent.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const initialContinuity = harness.sent('open')[1];
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current', 'continuity']);

  const starting = harness.api.start(replacementTrack);
  const replacement = harness.sent('open').at(-1);
  assert.equal(replacement.generation, initialCurrent.generation);
  assert.notEqual(replacement.streamId, initialCurrent.streamId);
  assert.notEqual(replacement.streamId, initialContinuity.streamId);
  acceptMetadata(harness, replacement);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: replacement.generation,
    streamId: replacement.streamId,
    sequence: 0,
    samples: new Array(12_000 * 2).fill(0.5),
  });

  const cutoverControlOffset = harness.sockets[0].sent.length;
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: replacement.generation,
    outgoingStreamId: initialCurrent.streamId,
    incomingStreamId: replacement.streamId,
    renderedFrame: 128,
    timelineFrame: 0,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  const promotedCurrent = await starting;
  assert.equal(promotedCurrent.generation, replacement.generation);
  assert.equal(promotedCurrent.streamId, replacement.streamId);

  const socket = harness.sockets[0];
  const context = harness.contexts[0];
  const node = harness.nodes[0];
  const resumeCalls = context.resumeCalls;
  const playCount = harness.portMessages('play').length;

  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: replacement.generation,
    streamId: replacement.streamId,
    renderedFrame: 128,
    contextTime: 13,
  });
  await harness.settle();

  const replacementControls = harness.sockets[0].sent
    .slice(cutoverControlOffset)
    .filter(({ type }) => type === 'promote' || type === 'open');
  assert.deepEqual(replacementControls.map(({ type, generation, streamId, role, path }) => ({
    type, generation, streamId, role, path,
  })), [
    {
      type: 'promote',
      generation: replacement.generation,
      streamId: replacement.streamId,
      role: undefined,
      path: undefined,
    },
  ]);
  assert.equal(harness.sent('open').length, 3);
  assert.equal(harness.engine.pendingContinuityTrack, adjacentTrack);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current']);
  assert.equal(harness.engine.roles.current.generation, replacement.generation);
  assert.equal(harness.engine.roles.current.streamId, replacement.streamId);
  assert.equal(harness.engine.roles.continuity, null);
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.nodes.length, 1);
  assert.equal(harness.engine.socket, socket);
  assert.equal(harness.engine.context, context);
  assert.equal(harness.engine.node, node);
  assert.equal(context.resumeCalls, resumeCalls);
  assert.equal(harness.portMessages('play').length, playCount);

  const openCountBeforeAck = harness.sent('open').length;
  const promotedAck = {
    type: 'promoted',
    generation: replacement.generation,
    streamId: replacement.streamId,
    role: 'current',
  };
  harness.sockets[0].receive(promotedAck);
  await adjacentRequest;
  await harness.settle();

  assert.equal(
    harness.api.snapshot().diagnostics.bufferedFrames.current,
    12_000,
    'the promoted current initially owns only its exact prepared replacement head',
  );
  assert.ok(
    harness.api.snapshot().diagnostics.inFlightFrames.current > 0,
    'ordinary promoted-current refill may already be in flight',
  );
  assert.equal(
    harness.sent('open').length,
    openCountBeforeAck,
    'an exact promotion acknowledgement must not let decoder competition outrun actual current PCM',
  );
  assert.equal(harness.engine.pendingContinuityTrack, adjacentTrack);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current']);
  assert.equal(harness.engine.roles.current.streamId, replacement.streamId);
  assert.equal(harness.engine.roles.continuity, null);

  harness.sockets[0].receive(promotedAck);
  await harness.settle();
  assert.equal(harness.sent('open').length, openCountBeforeAck);

  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: replacement.generation,
    streamId: replacement.streamId,
    sequence: 1,
    samples: new Array(36_000 * 2).fill(0.5),
  }, { role: 'current' });
  await harness.settle();

  assert.equal(harness.api.snapshot().diagnostics.bufferedFrames.current, 48_000);
  assert.equal(harness.sent('open').length, openCountBeforeAck + 1);
  const adjacent = harness.sent('open').at(-1);
  assert.equal(adjacent.path, adjacentTrack.path);
  assert.equal(adjacent.role, 'continuity');
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current', 'continuity']);
  assert.equal(harness.engine.roles.current.streamId, replacement.streamId);
  assert.equal(harness.engine.roles.continuity.streamId, adjacent.streamId);
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.nodes.length, 1);
  assert.equal(harness.engine.socket, socket);
  assert.equal(harness.engine.context, context);
  assert.equal(harness.engine.node, node);
  assert.equal(context.resumeCalls, resumeCalls);
  assert.equal(harness.portMessages('play').length, playCount);

  harness.sockets[0].receive(promotedAck);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: replacement.generation,
    streamId: replacement.streamId,
    sequence: 1,
    samples: new Array(36_000 * 2).fill(0.5),
  }, { expectedEnqueue: false });
  await harness.settle();
  assert.equal(harness.sent('open').length, openCountBeforeAck + 1);
  assert.equal(harness.engine.roles.current.streamId, replacement.streamId);
  assert.equal(harness.engine.roles.continuity.streamId, adjacent.streamId);
});

test('second rapid replacement reuses the promoted current before its exact promotion acknowledgement', async () => {
  const firstReplacementTrack = makeTrack('03.flac');
  const adjacentTrack = makeTrack('04.flac');
  const secondReplacementTrack = makeTrack('05.flac');
  let adjacentRequest = null;
  let harness;
  harness = createEngineHarness({
    handleStreamingPlaybackFirstFrame: (event) => {
      if (event.trackPath !== firstReplacementTrack.path) return null;
      adjacentRequest = harness.api.continuity(adjacentTrack, {
        kind: 'queued-next',
        startSeconds: 0,
      });
      return adjacentRequest;
    },
  });

  await harness.api.start(makeTrack('01.flac'));
  const initialCurrent = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: initialCurrent.generation,
    streamId: initialCurrent.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const initialContinuity = harness.sent('open')[1];
  assert.equal(initialCurrent.streamId, 1);
  assert.equal(initialContinuity.streamId, 2);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current', 'continuity']);

  const firstStarting = harness.api.start(firstReplacementTrack);
  const firstReplacement = harness.sent('open').at(-1);
  assert.equal(firstReplacement.generation, 1);
  assert.equal(firstReplacement.streamId, 3);
  acceptMetadata(harness, firstReplacement);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: firstReplacement.generation,
    streamId: firstReplacement.streamId,
    sequence: 0,
    samples: new Array(12_000 * 2).fill(0.5),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: firstReplacement.generation,
    outgoingStreamId: initialCurrent.streamId,
    incomingStreamId: firstReplacement.streamId,
    renderedFrame: 128,
    timelineFrame: 0,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  const promotedCurrent = await firstStarting;
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: firstReplacement.generation,
    streamId: firstReplacement.streamId,
    renderedFrame: 128,
    contextTime: 13,
  });
  await adjacentRequest;
  await harness.settle();

  assert.equal(promotedCurrent.streamId, 3);
  assert.equal(harness.sent('open').length, 3);
  assert.equal(harness.engine.pendingContinuityTrack, adjacentTrack);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current']);
  assert.equal(harness.engine.roles.continuity, null);
  assert.equal(harness.engine.pendingPromotion.streamId, promotedCurrent.streamId);

  const socket = harness.sockets[0];
  const context = harness.contexts[0];
  const node = harness.nodes[0];
  const closeCountBeforeSecondSelection = harness.sent('close').length;
  const openCountBeforeSecondSelection = harness.sent('open').length;
  const promoteCountBeforeSecondSelection = harness.sent('promote').length;
  const configureCountBeforeSecondSelection = harness.portMessages('configure').length;
  const stopCountBeforeSecondSelection = harness.portMessages('stop').length;
  const resumeCallsBeforeSecondSelection = context.resumeCalls;
  const playCountBeforeSecondSelection = harness.portMessages('play').length;
  const secondStarting = harness.api.start(secondReplacementTrack);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: firstReplacement.generation,
    streamId: firstReplacement.streamId,
    sequence: 1,
    samples: new Array(36_000 * 2).fill(0.5),
  }, { role: 'current' });
  await harness.settle();

  assert.equal(harness.sent('close').length, closeCountBeforeSecondSelection);
  const secondReplacement = harness.sent('open')[openCountBeforeSecondSelection];
  assert.deepEqual({
    generation: secondReplacement.generation,
    streamId: secondReplacement.streamId,
    role: secondReplacement.role,
    path: secondReplacement.path,
  }, {
    generation: 1,
    streamId: 4,
    role: 'continuity',
    path: secondReplacementTrack.path,
  });
  assert.equal(typeof secondStarting.then, 'function');
  assert.equal(harness.engine.pendingContinuityTrack, null);
  assert.equal(harness.engine.pendingContinuityOptions, null);
  assert.deepEqual({
    generation: harness.engine.pendingSeek.generation,
    currentStreamId: harness.engine.pendingSeek.currentStreamId,
    streamId: harness.engine.pendingSeek.streamId,
    startFrame: harness.engine.pendingSeek.startFrame,
    kind: harness.engine.pendingSeek.kind,
  }, {
    generation: 1,
    currentStreamId: promotedCurrent.streamId,
    streamId: secondReplacement.streamId,
    startFrame: 0,
    kind: 'replacement',
  });
  assert.equal(harness.engine.roles.current.generation, 1);
  assert.equal(harness.engine.roles.current.streamId, promotedCurrent.streamId);
  assert.equal(harness.engine.roles.continuity.generation, 1);
  assert.equal(harness.engine.roles.continuity.streamId, secondReplacement.streamId);
  assert.equal(harness.api.snapshot().paused, false);
  assert.equal(harness.portMessages('configure').length, configureCountBeforeSecondSelection);
  assert.equal(harness.portMessages('stop').length, stopCountBeforeSecondSelection);
  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.nodes.length, 1);
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.engine.socket, socket);
  assert.equal(harness.engine.context, context);
  assert.equal(harness.engine.node, node);
  assert.equal(context.resumeCalls, resumeCallsBeforeSecondSelection);
  assert.equal(harness.portMessages('play').length, playCountBeforeSecondSelection);

  acceptMetadata(harness, secondReplacement);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: secondReplacement.generation,
    streamId: secondReplacement.streamId,
    sequence: 0,
    samples: new Array(12_000 * 2).fill(0.75),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: secondReplacement.generation,
    outgoingStreamId: promotedCurrent.streamId,
    incomingStreamId: secondReplacement.streamId,
    renderedFrame: 256,
    timelineFrame: 0,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  const secondPromotedCurrent = await secondStarting;

  assert.equal(secondPromotedCurrent.streamId, secondReplacement.streamId);
  assert.equal(harness.engine.pendingSeek, null);
  assert.equal(harness.engine.pendingPromotion.streamId, secondReplacement.streamId);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current']);
  assert.equal(harness.engine.roles.current.streamId, secondReplacement.streamId);
  assert.equal(harness.engine.roles.continuity, null);
  assert.equal(harness.sent('promote').length, promoteCountBeforeSecondSelection + 1);

  const secondPromotedAck = {
    type: 'promoted',
    generation: secondReplacement.generation,
    streamId: secondReplacement.streamId,
    role: 'current',
  };
  harness.sockets[0].receive(secondPromotedAck);
  await harness.settle();
  const openCountAfterSecondAck = harness.sent('open').length;
  harness.sockets[0].receive(secondPromotedAck);
  await harness.settle();

  assert.equal(harness.sent('open').length, openCountAfterSecondAck);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current']);
  assert.equal(harness.engine.roles.current.streamId, secondReplacement.streamId);
  assert.equal(harness.engine.roles.continuity, null);
  assert.equal(harness.portMessages('configure').length, configureCountBeforeSecondSelection);
  assert.equal(harness.portMessages('stop').length, stopCountBeforeSecondSelection);
  assert.equal(context.resumeCalls, resumeCallsBeforeSecondSelection);
  assert.equal(harness.portMessages('play').length, playCountBeforeSecondSelection);
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.nodes.length, 1);
  assert.equal(harness.engine.socket, socket);
  assert.equal(harness.engine.context, context);
  assert.equal(harness.engine.node, node);
});

test('fresh playback keeps queued-next decoding behind one buffered second of the audible track', async () => {
  const harness = createEngineHarness();
  const currentTrack = makeTrack('current.flac');
  const queuedTrack = makeTrack('queued.flac');

  await harness.api.start(currentTrack, { startSeconds: 2.18 });
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });

  await harness.api.continuity(queuedTrack, { kind: 'queued-next', startSeconds: 0 });
  assert.equal(
    harness.sent('open').length,
    1,
    'adjacent decoding must not compete while the audible stream is still starved',
  );

  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  await harness.settle();

  assert.equal(harness.sent('open').length, 2);
  assert.equal(harness.sent('open')[1].path, queuedTrack.path);
  assert.equal(harness.sent('open')[1].role, 'continuity');
});

test('zero-start playback also keeps queued-next decoding behind the audible buffer', async () => {
  const harness = createEngineHarness();
  const currentTrack = makeTrack('current-zero.flac');
  const queuedTrack = makeTrack('queued-zero.flac');

  await harness.api.start(currentTrack);
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });

  await harness.api.continuity(queuedTrack, { kind: 'queued-next', startSeconds: 0 });
  assert.equal(
    harness.sent('open').length,
    1,
    'speculative adjacent decoding must not compete with a zero-start audible stream',
  );

  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  await harness.settle();

  assert.equal(harness.sent('open').length, 2);
  assert.equal(harness.sent('open')[1].path, queuedTrack.path);
});

test('queued-next metadata rechecks a cushion drained while its decoder opens', async () => {
  const harness = createEngineHarness();
  const currentTrack = makeTrack('current-vbr.mp3');
  const queuedTrack = makeTrack('queued.flac');

  await harness.api.start(currentTrack);
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  await harness.api.continuity(queuedTrack, { kind: 'queued-next', startSeconds: 0 });
  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  await harness.settle();

  const queued = harness.sent('open')[1];
  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    frames: 47_000,
    bufferedFrames: 1_000,
  });
  acceptMetadata(harness, queued);

  assert.equal(
    harness.sent('credit').filter(({ streamId }) => streamId === queued.streamId).length,
    0,
    'speculative decoding must remain idle after decoder startup drains the audible cushion',
  );

  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    sequence: 1,
    streamId: current.streamId,
    samples: new Array(48_000 * 2).fill(0.25),
  });

  assert.equal(
    harness.sent('credit').filter(({ streamId }) => streamId === queued.streamId).length,
    1,
    'queued decoding may start once current PCM restores the audible cushion',
  );
});

test('loop continuity replaces a stale queued role by identity and opens at the loop head', async () => {
  const harness = createEngineHarness();
  const currentTrack = makeTrack('current.flac');
  await harness.api.start(currentTrack);
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('queued.flac'), { kind: 'queued-next', startSeconds: 0 });
  const stale = harness.sent('open')[1];

  await harness.api.continuity(currentTrack, {
    kind: 'short-loop', startSeconds: 12, endSeconds: 16,
  });

  assert.deepEqual(harness.sent('close').slice(-1), [{
    type: 'close', generation: stale.generation, streamId: stale.streamId,
    reason: 'continuity-replaced',
  }]);
  const loopOpen = harness.sent('open').at(-1);
  assert.equal(loopOpen.role, 'continuity');
  assert.equal(loopOpen.path, currentTrack.path);
  assert.equal(loopOpen.startFrame, 12 * 48_000);
  assert.deepEqual({ ...harness.portMessages('set-loop').at(-1) }, {
    type: 'set-loop', generation: current.generation, active: true,
    kind: 'short-loop',
    startFrame: 12 * 48_000, endFrame: 16 * 48_000, retainedStreamId: loopOpen.streamId,
  });
});

test('repeating the exact continuity options identity does not restart its decoder', async () => {
  const harness = createEngineHarness();
  const track = makeTrack('identity.flac');
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    samples: new Array(128 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });
  const options = { kind: 'short-loop', startSeconds: 12, endSeconds: 16 };

  await harness.api.continuity(track, options);
  const role = harness.sent('open')[1];
  await harness.api.continuity(track, { ...options });

  assert.equal(harness.sent('open').length, 2);
  assert.equal(harness.sent('close').length, 0);
  assert.equal(harness.engine.roles.continuity.streamId, role.streamId);
  assert.deepEqual({ ...harness.engine.roles.continuity.continuityOptions }, options);
});

test('replacing a prepared loop releases its exact worklet identity before installing the new head', async () => {
  const harness = createEngineHarness();
  const track = makeTrack('loop-replacement.flac');
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });

  await harness.api.continuity(track, {
    kind: 'long-loop', startSeconds: 1, endSeconds: 30,
  });
  const firstHead = harness.sent('open')[1];
  await harness.api.continuity(track, {
    kind: 'long-loop', startSeconds: 1, endSeconds: 7,
  });
  const replacementHead = harness.sent('open')[2];

  assert.deepEqual(
    harness.portMessages('set-loop').map((message) => ({ ...message })),
    [
      {
        type: 'set-loop', generation: current.generation, active: true,
        kind: 'long-loop', startFrame: 48_000, endFrame: 30 * 48_000,
        retainedStreamId: firstHead.streamId,
      },
      {
        type: 'set-loop', generation: current.generation, active: false,
        kind: 'long-loop', startFrame: 48_000, endFrame: 30 * 48_000,
        retainedStreamId: firstHead.streamId,
      },
      {
        type: 'set-loop', generation: current.generation, active: true,
        kind: 'long-loop', startFrame: 48_000, endFrame: 7 * 48_000,
        retainedStreamId: replacementHead.streamId,
      },
    ],
  );
});

test('short-loop first and repeated wraps remain local without promoting server roles', async () => {
  const harness = createEngineHarness();
  const track = makeTrack('short-loop.flac');
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });
  await harness.api.continuity(track, {
    kind: 'short-loop', startSeconds: 1, endSeconds: 4,
  });
  const retained = harness.sent('open')[1];
  acceptMetadata(harness, retained);
  receivePcmAndAssertEnqueue(harness, {
    generation: retained.generation,
    streamId: retained.streamId,
    role: 1,
    samples: [0.35, -0.35],
  });

  for (const outgoingStreamId of [current.streamId, retained.streamId]) {
    harness.nodes[0].port.dispatch({
      type: 'boundary', generation: current.generation,
      outgoingStreamId, incomingStreamId: retained.streamId,
      renderedFrame: 4 * 48_000, timelineFrame: (1 * 48_000) + 64,
      capture: { outgoing: { frames: 64 }, incoming: { frames: 64 } },
    });
  }
  harness.nodes[0].port.dispatch({
    type: 'consumed', generation: retained.generation, streamId: retained.streamId,
    role: 'continuity', frames: 1, bufferedFrames: 0, audible: true,
    finiteSamples: 2, nonZeroSamples: 2, peakSample: 0.35, samples: [0.35, -0.35],
  });
  harness.nodes[0].port.dispatch({
    type: 'consumed', generation: current.generation, streamId: current.streamId,
    role: 'current', frames: 1, bufferedFrames: 0, audible: false,
    finiteSamples: 2, nonZeroSamples: 2, peakSample: 0.2, samples: [0.2, -0.2],
  });

  assert.equal(harness.sent('promote').length, 0);
  assert.equal(harness.engine.roles.current.streamId, current.streamId);
  assert.equal(harness.engine.roles.continuity.streamId, retained.streamId);
  assert.equal(harness.api.snapshot().diagnostics.pcmEvidence.streamId, retained.streamId);
  assert.equal(harness.api.snapshot().diagnostics.pcmEvidence.nonZeroSamples, 2);
  assert.equal(harness.api.snapshot().diagnostics.renderedPcmEvidence.streamId, retained.streamId);
  assert.equal(harness.api.snapshot().diagnostics.renderedPcmEvidence.peakSample, 0.35);
  assert.equal(harness.api.snapshot().currentTime, 1 + (65 / 48_000));
  harness.nodes[0].port.dispatch({
    type: 'position', generation: current.generation, streamId: current.streamId,
    timelineFrame: 2 * 48_000,
  });
  assert.equal(harness.api.snapshot().currentTime, 2);
});

test('a loop longer than five seconds promotes the stable head then prepares the next iteration', async () => {
  const harness = createEngineHarness();
  const track = makeTrack('long-loop.flac');
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });
  await harness.api.continuity(track, { kind: 'long-loop', startSeconds: 8, endSeconds: 20 });
  const head = harness.sent('open')[1];
  assert.equal(head.startFrame, 8 * 48_000);

  harness.nodes[0].port.dispatch({
    type: 'boundary', generation: current.generation,
    outgoingStreamId: current.streamId, incomingStreamId: head.streamId,
    renderedFrame: 20 * 48_000, timelineFrame: (8 * 48_000) + 64,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 64 } },
  });
  assert.equal(harness.api.snapshot().currentTime, 8 + (64 / 48_000));
  assert.deepEqual(harness.sent('promote').at(-1), {
    type: 'promote', generation: current.generation, streamId: head.streamId,
    fromRole: 'continuity', toRole: 'current',
  });
  harness.sockets[0].receive({
    type: 'promoted', generation: current.generation, streamId: head.streamId, role: 'current',
  });
  await harness.settle();

  const nextHead = harness.sent('open').at(-1);
  assert.equal(nextHead.role, 'continuity');
  assert.equal(nextHead.path, track.path);
  assert.equal(nextHead.startFrame, 8 * 48_000);
  assert.notEqual(nextHead.streamId, head.streamId);
});

test('whole-track repeat uses the long-loop policy and prepares every iteration from frame zero', async () => {
  const harness = createEngineHarness();
  const track = makeTrack('repeat.flac');
  track.durationSeconds = 4;
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });

  await harness.api.continuity(track, {
    kind: 'whole-track-repeat', startSeconds: 0, endSeconds: track.durationSeconds,
  });

  const repeatHead = harness.sent('open')[1];
  assert.equal(repeatHead.path, track.path);
  assert.equal(repeatHead.startFrame, 0);
  assert.deepEqual({ ...harness.portMessages('set-loop').at(-1) }, {
    type: 'set-loop', generation: current.generation, active: true,
    kind: 'whole-track-repeat',
    startFrame: 0, endFrame: track.durationSeconds * 48_000,
    retainedStreamId: repeatHead.streamId,
  });
});

test('disabling a loop cancels its exact stale role before queued continuity is restored', async () => {
  const harness = createEngineHarness();
  const currentTrack = makeTrack('current.flac');
  const queuedTrack = makeTrack('queued.flac');
  await harness.api.start(currentTrack);
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });
  await harness.api.continuity(currentTrack, {
    kind: 'short-loop', startSeconds: 4, endSeconds: 8,
  });
  const loopRole = harness.sent('open')[1];

  await harness.api.setLoop(false, 4, 8);
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(queuedTrack, { kind: 'queued-next', startSeconds: 0 });

  assert.deepEqual(harness.sent('close').slice(-1), [{
    type: 'close', generation: loopRole.generation, streamId: loopRole.streamId,
    reason: 'loop-disabled',
  }]);
  const restored = harness.sent('open').at(-1);
  assert.equal(restored.role, 'continuity');
  assert.equal(restored.path, queuedTrack.path);
  assert.notEqual(restored.streamId, loopRole.streamId);
  assert.deepEqual({ ...harness.portMessages('set-loop').at(-1) }, {
    type: 'set-loop', generation: current.generation, active: false,
    kind: 'short-loop',
    startFrame: 4 * 48_000, endFrame: 8 * 48_000,
    retainedStreamId: loopRole.streamId,
  });
});

test('a near-end seek prepares its target without stopping the selected current stream', async () => {
  const harness = createEngineHarness();
  const track = makeTrack();
  await harness.api.start(track);
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  await harness.api.continuity(makeTrack('02.flac'));

  await harness.api.seek(239.75);

  const replacement = harness.sent('open').at(-1);
  assert.equal(replacement.role, 'continuity');
  assert.equal(replacement.startFrame, 239.75 * 48_000);
  assert.equal(replacement.generation, current.generation);
  assert.equal(harness.engine.roles.current.streamId, current.streamId);
  assert.equal(harness.api.snapshot().mode, 'playing');
  acceptMetadata(harness, replacement, { provisionalTotalFrames: 240 * 48_000 });
  assert.equal(harness.sent('credit').at(-1).frames, 12_000);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: replacement.generation,
    streamId: replacement.streamId,
    sequence: 0,
    samples: new Array(11_999 * 2).fill(0.25),
  });
  assert.equal(harness.portMessages('prepare-seek').length, 0);
  harness.sockets[0].receive({
    type: 'eos',
    generation: replacement.generation,
    streamId: replacement.streamId,
    role: 'continuity',
    emittedFrames: 11_999,
    authoritativeTotalFrames: 11_999,
  });
  assert.equal(harness.portMessages('prepare-seek').at(-1).streamId, replacement.streamId);
});

test('retains inspectable socket and processor failures in engine diagnostics', async (t) => {
  for (const failure of [
    {
      name: 'socket',
      trigger: (harness) => harness.sockets[0].fail(new Error('transport gone')),
      message: 'transport gone',
    },
    {
      name: 'processor',
      trigger: (harness) => harness.nodes[0].fail(new Error('render crashed')),
      message: 'render crashed',
    },
  ]) {
    await t.test(failure.name, async () => {
      const harness = createEngineHarness();
      await harness.api.start(makeTrack());
      failure.trigger(harness);
      const snapshot = harness.api.snapshot();
      assert.equal(snapshot.mode, 'error');
      assert.equal(snapshot.diagnostics.lastError.source, failure.name);
      assert.match(snapshot.diagnostics.lastError.message, new RegExp(failure.message));
    });
  }
});

test('stop performs exact cleanup once and remains idempotent', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const continuity = harness.sent('open')[1];

  await harness.api.stop('ownership-lost');
  await harness.api.stop('ownership-lost');

  assert.deepEqual(
    harness.sent('close').map(({ streamId, reason }) => ({ streamId, reason })),
    [
      { streamId: current.streamId, reason: 'ownership-lost' },
      { streamId: continuity.streamId, reason: 'ownership-lost' },
    ],
  );
  assert.equal(harness.portMessages('stop').length, 1);
  assert.equal(harness.portMessages('stop')[0].reason, 'ownership-lost');
  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.nodes[0].disconnectCalls, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  const snapshot = harness.api.snapshot();
  assert.deepEqual(
    Object.fromEntries(
      ['currentTime', 'duration', 'paused', 'ended', 'src', 'readyState']
        .map((key) => [key, snapshot[key]]),
    ),
    {
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
      src: '',
      readyState: 0,
    },
  );
});

test('playing replacement prepares a clean head and cuts over without clearing audible current PCM', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('01.flac'));
  const firstCurrent = harness.sent('open')[0];
  acceptMetadata(harness, firstCurrent);
  receivePcmAndAssertEnqueue(harness, {
    generation: firstCurrent.generation,
    streamId: firstCurrent.streamId,
    samples: new Array(128 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: firstCurrent.generation,
    streamId: firstCurrent.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const firstContinuity = harness.sent('open')[1];

  const starting = harness.api.start(makeTrack('03.flac'));

  const controls = harness.sockets[0].sent;
  const replacementOpenIndex = controls.findLastIndex(({ type }) => type === 'open');
  const replacement = controls[replacementOpenIndex];
  assert.deepEqual(
    controls.slice(replacementOpenIndex - 1, replacementOpenIndex)
      .map(({ type, generation, streamId, reason }) => ({ type, generation, streamId, reason })),
    [
      {
        type: 'close',
        generation: firstContinuity.generation,
        streamId: firstContinuity.streamId,
        reason: 'replacement-target',
      },
    ],
  );
  assert.equal(replacement.generation, firstCurrent.generation);
  assert.equal(replacement.role, 'continuity');
  assert.equal(replacement.path, makeTrack('03.flac').path);
  assert.equal(harness.engine.roles.current.streamId, firstCurrent.streamId);
  assert.deepEqual({ ...harness.portMessages('drop-continuity').at(-1) }, {
    type: 'drop-continuity', generation: firstContinuity.generation,
    streamId: firstContinuity.streamId,
  });
  assert.equal(harness.portMessages('configure').length, 1);
  acceptMetadata(harness, replacement);
  receivePcmAndAssertEnqueue(harness, {
    role: 1, generation: replacement.generation, streamId: replacement.streamId,
    sequence: 0, samples: new Array(12_000 * 2).fill(0.5),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary', generation: replacement.generation,
    outgoingStreamId: firstCurrent.streamId, incomingStreamId: replacement.streamId,
    renderedFrame: 128, timelineFrame: 0, silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  const started = await starting;
  assert.equal(started.streamId, replacement.streamId);
  assert.equal(harness.sent('promote').at(-1).streamId, replacement.streamId);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current']);
});

test('prepared replacement preserves its buffered outgoing cushion while retaining head priority', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('outgoing.flac'));
  const outgoing = harness.sent('open')[0];
  acceptMetadata(harness, outgoing);
  receivePcmAndAssertEnqueue(harness, {
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });

  const outgoingCreditCountBeforeReplacement = harness.sent('credit')
    .filter(({ streamId }) => streamId === outgoing.streamId).length;
  const starting = harness.api.start(makeTrack('replacement.flac'));
  const replacement = harness.sent('open').at(-1);
  assert.equal(harness.sockets.length, 1);
  assert.equal(replacement.generation, outgoing.generation);
  assert.notEqual(replacement.streamId, outgoing.streamId);
  assert.equal(harness.engine.pendingSeek.kind, 'replacement');
  assert.equal(harness.engine.pendingSeek.currentStreamId, outgoing.streamId);
  assert.equal(harness.engine.pendingSeek.streamId, replacement.streamId);

  receivePcmAndAssertEnqueue(harness, {
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    sequence: 1,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'consumed',
    role: 'current',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    frames: 48_000,
    bufferedFrames: 48_000,
  });

  const outgoingSafetyCredits = harness.sent('credit')
    .filter(({ streamId }) => streamId === outgoing.streamId)
    .slice(outgoingCreditCountBeforeReplacement);
  assert.deepEqual(
    outgoingSafetyCredits.map(({ frames }) => frames),
    [48_000],
    'replacement preparation restores a second outgoing second after the incoming head is prioritized',
  );

  acceptMetadata(harness, replacement);
  const replacementHeadCredits = harness.sent('credit')
    .filter(({ streamId }) => streamId === replacement.streamId);
  assert.deepEqual(
    replacementHeadCredits.map(({ frames }) => frames),
    [48_000],
    'replacement metadata must reserve one buffered second before cutover',
  );
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: replacement.generation,
    streamId: replacement.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(0.5),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: replacement.generation,
    outgoingStreamId: outgoing.streamId,
    incomingStreamId: replacement.streamId,
    renderedFrame: 128,
    timelineFrame: 0,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  const promoted = await starting;

  assert.equal(promoted.streamId, replacement.streamId);
  assert.equal(harness.engine.roles.current.streamId, replacement.streamId);
  assert.equal(harness.engine.roles.current.generation, outgoing.generation);
  assert.equal(harness.sockets.length, 1);
  assert.ok(
    harness.sent('credit').filter(({ streamId }) => streamId === replacement.streamId).length
      > replacementHeadCredits.length,
    'ordinary refill must resume for the promoted current identity',
  );
  assert.deepEqual(
    harness.sent('credit')
      .filter(({ streamId }) => streamId === outgoing.streamId)
      .slice(outgoingCreditCountBeforeReplacement)
      .map(({ frames }) => frames),
    [48_000],
    'replacement preparation must retain exactly two outgoing seconds without overfilling',
  );
});

test('replacement decoder opens only after the outgoing stream has an actual render cushion', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('outgoing-vbr.mp3'));
  const outgoing = harness.sent('open')[0];
  acceptMetadata(harness, outgoing);
  receivePcmAndAssertEnqueue(harness, {
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    sequence: 0,
    samples: new Array(1_199 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.api.start(makeTrack('replacement.flac'));

  assert.equal(
    harness.sent('open').length,
    1,
    'the replacement decoder must not compete while only outgoing credit is pending',
  );

  receivePcmAndAssertEnqueue(harness, {
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    sequence: 1,
    samples: new Array(46_801 * 2).fill(0.25),
  });
  await harness.settle();
  const replacement = harness.sent('open').at(-1);
  acceptMetadata(harness, replacement);

  assert.deepEqual(
    harness.sent('credit')
      .filter(({ streamId }) => streamId === replacement.streamId)
      .map(({ frames }) => frames),
    [48_000],
    'replacement decoding begins once one second of outgoing audio is actually buffered',
  );
});

test('stalled outgoing replacement cushion falls back to a cold replacement start', async () => {
  const timers = [];
  const harness = createEngineHarness({
    setTimeout(callback, delay) {
      timers.push({ callback, delay, cleared: false });
      return timers.length;
    },
    clearTimeout(id) {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
  });
  await harness.api.start(makeTrack('stalled-outgoing.flac'));
  const outgoing = harness.sent('open')[0];
  acceptMetadata(harness, outgoing);
  receivePcmAndAssertEnqueue(harness, {
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    samples: new Array(1_199 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });

  const starting = harness.api.start(makeTrack('fallback.flac'));
  assert.equal(harness.sent('open').length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1000);
  timers[0].callback();
  await harness.settle();

  const fallback = harness.sent('open').at(-1);
  assert.equal(fallback.role, 'current');
  assert.equal(fallback.path, makeTrack('fallback.flac').path);
  assert.notEqual(fallback.generation, outgoing.generation);
  acceptMetadata(harness, fallback);
  receivePcmAndAssertEnqueue(harness, {
    generation: fallback.generation,
    streamId: fallback.streamId,
    samples: new Array(12_000 * 2).fill(0.5),
  });
  assert.equal((await starting).streamId, fallback.streamId);
});

test('consumed audio replenishes a promoted current stream in coarse windows', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('outgoing.flac'));
  const outgoing = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;

  const starting = harness.api.start(makeTrack('replacement.flac'));
  const current = harness.sent('open').at(-1);
  acceptMetadata(harness, current);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: current.generation,
    streamId: current.streamId,
    sequence: 0,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: current.generation,
    streamId: current.streamId,
    sequence: 1,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: current.generation,
    outgoingStreamId: outgoing.streamId,
    incomingStreamId: current.streamId,
    renderedFrame: 128,
    timelineFrame: 0,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  await starting;

  let sequence = 2;
  while (harness.api.snapshot().diagnostics.inFlightFrames.current >= 48_000) {
    receivePcmAndAssertEnqueue(harness, {
      role: 1,
      generation: current.generation,
      streamId: current.streamId,
      sequence,
      samples: new Array(48_000 * 2).fill(0.25),
    }, { role: 'current' });
    sequence += 1;
  }
  const startingBufferedFrames = harness.api.snapshot().diagnostics.bufferedFrames.current;
  const creditCount = harness.sent('credit').length;
  for (let quantum = 1; quantum < 375; quantum += 1) {
    harness.nodes[0].port.dispatch({
      type: 'consumed',
      generation: current.generation,
      streamId: current.streamId,
      role: 'current',
      frames: 128,
      bufferedFrames: startingBufferedFrames - (quantum * 128),
    });
  }
  assert.equal(
    harness.sent('credit').length,
    creditCount,
    'sub-window consumption must not emit one WebSocket credit per AudioWorklet quantum',
  );

  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    frames: 128,
    bufferedFrames: startingBufferedFrames - 48_000,
  });
  assert.equal(harness.sent('credit').length, creditCount + 1);
  assert.equal(harness.sent('credit').at(-1).frames, 48_000);
});

test('fragmented current PCM waits for the transport low-water mark before refilling', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  const initialCreditCount = harness.sent('credit').length;

  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    sequence: 0,
    samples: new Array(4_096 * 2).fill(0.25),
  });
  assert.equal(
    harness.sent('credit').length,
    initialCreditCount,
    'a decoder fragment must not trigger an equally fragmented WebSocket credit',
  );

  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    sequence: 1,
    samples: new Array(32_000 * 2).fill(0.25),
  });
  assert.equal(harness.sent('credit').length, initialCreditCount + 1);
  assert.equal(
    harness.sent('credit').at(-1).frames,
    36_096,
    'the refill restores one full transport window before the decoder runs dry',
  );
});

test('a new current generation starts its cached waveform probe before playback readiness', async () => {
  const probes = [];
  const harness = createEngineHarness({
    probeCachedWaveformPeaks: (path, generation) => {
      probes.push({ path, generation });
      return Promise.resolve(null);
    },
  });
  const track = makeTrack('cached-waveform.flac');

  const current = await harness.api.start(track);

  assert.deepEqual(probes, [{ path: track.path, generation: current.generation }]);
});

test('active replacement restores a drained outgoing render cushion after a delivery stall', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('outgoing.flac'));
  const outgoing = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;

  harness.api.start(makeTrack('replacement.flac'));
  const replacement = harness.sent('open').at(-1);
  acceptMetadata(harness, replacement);
  const incomingHeadCreditIndex = harness.sockets[0].sent.findLastIndex((message) => (
    message.type === 'credit' && message.streamId === replacement.streamId
  ));

  harness.engine.diagnostics.bufferedFrames.current = 1_152;
  harness.engine.diagnostics.inFlightFrames.current = 0;
  const outgoingCreditOffset = harness.sent('credit')
    .filter(({ streamId }) => streamId === outgoing.streamId).length;

  harness.nodes[0].port.dispatch({
    type: 'consumed',
    role: 'current',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    frames: 128,
    bufferedFrames: 1_024,
  });

  const outgoingCushionCredits = harness.sent('credit')
    .filter(({ streamId }) => streamId === outgoing.streamId)
    .slice(outgoingCreditOffset);
  assert.deepEqual(
    outgoingCushionCredits.map(({ frames }) => frames),
    [48_000],
    'one delayed quantum must request a coarse outgoing refill behind the replacement head',
  );
  assert.equal(
    harness.api.snapshot().diagnostics.bufferedFrames.current
      + harness.api.snapshot().diagnostics.inFlightFrames.current,
    49_024,
  );
  const outgoingCushionCreditIndex = harness.sockets[0].sent.findLastIndex((message) => (
    message.type === 'credit' && message.streamId === outgoing.streamId
  ));
  assert.ok(
    outgoingCushionCreditIndex > incomingHeadCreditIndex,
    'the replacement head must retain socket-credit priority over cushion restoration',
  );
});

test('latest seek during locally committed replacement promotion runs after exact ack', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('outgoing.flac'));
  const outgoing = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;

  const starting = harness.api.start(makeTrack('replacement.flac'));
  const replacement = harness.sent('open').at(-1);
  acceptMetadata(harness, replacement);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: replacement.generation,
    streamId: replacement.streamId,
    sequence: 0,
    samples: new Array(12_000 * 2).fill(0.5),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: replacement.generation,
    outgoingStreamId: outgoing.streamId,
    incomingStreamId: replacement.streamId,
    renderedFrame: 128,
    timelineFrame: 0,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  await starting;
  assert.equal(harness.engine.pendingPromotion.kind, 'replacement');
  assert.equal(harness.engine.pendingPromotion.streamId, replacement.streamId);

  const openOffset = harness.sent('open').length;
  await harness.api.seek(10);
  await harness.api.seek(37.5);
  assert.equal(
    harness.sent('open').length,
    openOffset,
    'seek must wait until the locally committed identity is acknowledged by the server',
  );

  harness.sockets[0].receive({
    type: 'promoted',
    generation: replacement.generation,
    streamId: replacement.streamId,
    role: 'current',
  });
  await harness.settle();

  const seekOpens = harness.sent('open').slice(openOffset);
  assert.deepEqual(
    seekOpens.map(({ generation, role, path, startFrame }) => ({
      generation, role, path, startFrame,
    })),
    [{
      generation: replacement.generation,
      role: 'continuity',
      path: makeTrack('replacement.flac').path,
      startFrame: Math.round(37.5 * 48_000),
    }],
    'promotion-time clicks must coalesce to the latest requested playback position',
  );
  assert.equal(harness.sockets.length, 1, 'seek reuses the existing decoder socket');
});

test('paused seek during locally committed promotion runs after exact ack without resuming', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('outgoing.flac'));
  const outgoing = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;

  const starting = harness.api.start(makeTrack('replacement.flac'));
  const replacement = harness.sent('open').at(-1);
  acceptMetadata(harness, replacement);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: replacement.generation,
    streamId: replacement.streamId,
    sequence: 0,
    samples: new Array(12_000 * 2).fill(0.5),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: replacement.generation,
    outgoingStreamId: outgoing.streamId,
    incomingStreamId: replacement.streamId,
    renderedFrame: 128,
    timelineFrame: 0,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  await starting;

  await harness.api.pause();
  const resumeCalls = harness.contexts[0].resumeCalls;
  const playCount = harness.portMessages('play').length;
  const openOffset = harness.sent('open').length;
  await harness.api.seek(22.25);
  assert.equal(harness.sent('open').length, openOffset);

  harness.sockets[0].receive({
    type: 'promoted',
    generation: replacement.generation,
    streamId: replacement.streamId,
    role: 'current',
  });
  await harness.settle();

  assert.deepEqual(
    harness.sent('open').slice(openOffset)
      .map(({ generation, role, path, startFrame }) => ({
        generation, role, path, startFrame,
      })),
    [{
      generation: replacement.generation,
      role: 'continuity',
      path: makeTrack('replacement.flac').path,
      startFrame: Math.round(22.25 * 48_000),
    }],
  );
  assert.equal(harness.api.snapshot().paused, true);
  assert.equal(harness.contexts[0].resumeCalls, resumeCalls);
  assert.equal(harness.portMessages('play').length, playCount);
  assert.equal(harness.sockets.length, 1);
});

test('latest seek during locally committed natural promotion runs after exact ack', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('01.flac'));
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const promoted = harness.sent('open')[1];

  harness.nodes[0].port.dispatch({
    type: 'boundary',
    generation: current.generation,
    outgoingStreamId: current.streamId,
    incomingStreamId: promoted.streamId,
    renderedFrame: 11_520_000,
    capture: { outgoing: { frames: 0 }, incoming: { frames: 1 } },
  });
  assert.equal(harness.engine.roles.current.streamId, promoted.streamId);
  assert.equal(harness.engine.roles.current.boundaryNotified, true);

  const openOffset = harness.sent('open').length;
  await harness.api.seek(12);
  await harness.api.seek(45);
  assert.equal(harness.sent('open').length, openOffset);

  harness.sockets[0].receive({
    type: 'promoted',
    generation: promoted.generation,
    streamId: promoted.streamId,
    role: 'current',
  });
  await harness.settle();

  assert.deepEqual(
    harness.sent('open').slice(openOffset)
      .map(({ generation, role, path, startFrame }) => ({
        generation, role, path, startFrame,
      })),
    [{
      generation: promoted.generation,
      role: 'continuity',
      path: makeTrack('02.flac').path,
      startFrame: 45 * 48_000,
    }],
  );
  assert.equal(harness.sockets.length, 1);
});

test('autoplay false opens a fresh paused generation without resuming audio', async () => {
  const harness = createEngineHarness();
  const restored = await harness.api.start(makeTrack('03.flac'), {
    startSeconds: 37.5,
    autoplay: false,
  });

  assert.equal(restored.generation, 1);
  assert.equal(restored.startFrame, Math.round(37.5 * 48_000));
  assert.equal(harness.sent('open').length, 1);
  assert.equal(harness.contexts[0].resumeCalls, 0);
  assert.equal(harness.contexts[0].state, 'suspended');
  assert.equal(harness.portMessages('play').length, 0);
  assert.equal(harness.api.snapshot().paused, true);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current']);
});

test('autoplay start remains paused when the AudioContext resume resolves suspended', async () => {
  const harness = createEngineHarness({ resumeLeavesSuspended: true });

  const started = await harness.api.start(makeTrack('03.flac'), { autoplay: true });

  assert.equal(started, null);
  assert.equal(harness.contexts[0].state, 'suspended');
  assert.equal(harness.portMessages('play').length, 0);
  assert.equal(harness.api.snapshot().paused, true);
});

test('restore-only autoplay fallback retains the fresh paused role when Chrome leaves the context suspended', async () => {
  const harness = createEngineHarness({ resumeLeavesSuspended: true });
  let autoplayStartedCalls = 0;

  const restored = await harness.api.start(makeTrack('03.flac'), {
    startSeconds: 37.5,
    autoplay: true,
    allowSuspendedAutoplayFallback: true,
    onAutoplayStarted: () => { autoplayStartedCalls += 1; },
  });

  assert.equal(restored.generation, 1);
  assert.equal(restored.startFrame, Math.round(37.5 * 48_000));
  assert.equal(harness.engine.roles.current, restored);
  assert.equal(harness.engine.mode, 'paused');
  assert.equal(harness.contexts[0].state, 'suspended');
  assert.equal(harness.portMessages('play').length, 0);
  assert.equal(harness.api.snapshot().paused, true);
  assert.equal(autoplayStartedCalls, 0);
});

test('restore-only autoplay completes once when a pending Chrome resume succeeds after the fallback boundary', async () => {
  let resolveResume;
  const resumeGate = new Promise((resolve) => {
    resolveResume = resolve;
  });
  const settlementDelays = [];
  const harness = createEngineHarness({
    resumeContext: () => resumeGate,
    clearTimeout: () => {},
    setTimeout: (callback, delay) => {
      settlementDelays.push(delay);
      queueMicrotask(callback);
      return 1;
    },
  });
  let autoplayStartedCalls = 0;

  const restored = await harness.api.start(makeTrack('03.flac'), {
    startSeconds: 37.5,
    autoplay: true,
    allowSuspendedAutoplayFallback: true,
    onAutoplayStarted: () => { autoplayStartedCalls += 1; },
  });

  assert.deepEqual(settlementDelays, [750]);
  assert.equal(restored.generation, 1);
  assert.equal(restored.startFrame, Math.round(37.5 * 48_000));
  assert.equal(harness.engine.roles.current, restored);
  assert.equal(harness.engine.mode, 'paused');
  assert.equal(harness.contexts[0].state, 'suspended');
  assert.equal(harness.portMessages('play').length, 0);
  assert.equal(harness.api.snapshot().paused, true);
  assert.equal(autoplayStartedCalls, 0);

  resolveResume();
  await harness.settle();

  assert.equal(harness.contexts[0].state, 'running');
  assert.equal(harness.portMessages('play').length, 1);
  assert.equal(harness.api.snapshot().paused, false);
  assert.equal(autoplayStartedCalls, 1);
});

test('restore-only autoplay fallback reports a late current-context resume rejection', async () => {
  let rejectResume;
  const resumeGate = new Promise((resolve, reject) => {
    rejectResume = reject;
  });
  const harness = createEngineHarness({
    resumeContext: () => resumeGate,
    clearTimeout: () => {},
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
  });

  const restored = await harness.api.start(makeTrack('03.flac'), {
    autoplay: true,
    allowSuspendedAutoplayFallback: true,
  });
  assert.equal(harness.engine.roles.current, restored);
  assert.equal(harness.engine.mode, 'paused');

  rejectResume(new Error('late context resume denied'));
  await harness.settle();
  await harness.settle();

  const snapshot = harness.api.snapshot();
  assert.equal(snapshot.mode, 'error');
  assert.equal(snapshot.diagnostics.lastError.source, 'context');
  assert.match(snapshot.diagnostics.lastError.message, /late context resume denied/);
  assert.deepEqual([...snapshot.diagnostics.activeRoles], []);
});

test('restore-only autoplay fallback preserves pre-boundary resume rejection propagation', async () => {
  const resumeError = new Error('immediate context resume denied');
  const harness = createEngineHarness({
    resumeContext: async () => { throw resumeError; },
    setTimeout: () => 1,
  });

  await assert.rejects(
    harness.api.start(makeTrack('03.flac'), {
      autoplay: true,
      allowSuspendedAutoplayFallback: true,
    }),
    resumeError,
  );

  assert.equal(harness.engine.mode, 'starting');
  assert.equal(harness.api.snapshot().diagnostics.lastError, undefined);
  assert.equal(harness.portMessages('play').length, 0);
});

test('restore-only autoplay fallback ignores late resume rejection after role replacement', async () => {
  let rejectResume;
  const resumeGate = new Promise((resolve, reject) => {
    rejectResume = reject;
  });
  const harness = createEngineHarness({
    resumeContext: () => resumeGate,
    clearTimeout: () => {},
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
  });
  let autoplayStartedCalls = 0;

  const restored = await harness.api.start(makeTrack('03.flac'), {
    autoplay: true,
    allowSuspendedAutoplayFallback: true,
    onAutoplayStarted: () => { autoplayStartedCalls += 1; },
  });
  harness.engine.roles.current = { ...restored, streamId: restored.streamId + 1 };

  rejectResume(new Error('stale context resume denied'));
  await harness.settle();

  const snapshot = harness.api.snapshot();
  assert.equal(snapshot.mode, 'paused');
  assert.equal(snapshot.diagnostics.lastError, undefined);
  assert.equal(autoplayStartedCalls, 0);
});

test('restore-only autoplay fallback ignores late rejection after manual resume succeeds', async () => {
  let rejectRestoreResume;
  let resumeCall = 0;
  const restoreResumeGate = new Promise((resolve, reject) => {
    rejectRestoreResume = reject;
  });
  const harness = createEngineHarness({
    resumeContext: () => {
      resumeCall += 1;
      return resumeCall === 1 ? restoreResumeGate : undefined;
    },
    clearTimeout: () => {},
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
  });
  let autoplayStartedCalls = 0;

  const restored = await harness.api.start(makeTrack('03.flac'), {
    autoplay: true,
    allowSuspendedAutoplayFallback: true,
    onAutoplayStarted: () => { autoplayStartedCalls += 1; },
  });
  const resumed = await harness.api.resume();
  assert.equal(resumed, true);
  assert.equal(harness.api.snapshot().paused, false);

  rejectRestoreResume(new Error('obsolete context resume denied'));
  await harness.settle();

  assert.equal(harness.engine.roles.current, restored);
  assert.equal(harness.api.snapshot().mode, 'starting');
  assert.equal(harness.api.snapshot().diagnostics.lastError, undefined);
  assert.equal(harness.portMessages('play').length, 1);
  assert.equal(autoplayStartedCalls, 0);
});

test('manual resume wins before the original restore resume succeeds without a duplicate completion', async () => {
  let resolveRestoreResume;
  let resumeCall = 0;
  const restoreResumeGate = new Promise((resolve) => {
    resolveRestoreResume = resolve;
  });
  const harness = createEngineHarness({
    resumeContext: () => {
      resumeCall += 1;
      return resumeCall === 1 ? restoreResumeGate : undefined;
    },
    clearTimeout: () => {},
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
  });
  let autoplayStartedCalls = 0;

  const restored = await harness.api.start(makeTrack('03.flac'), {
    autoplay: true,
    allowSuspendedAutoplayFallback: true,
    onAutoplayStarted: () => { autoplayStartedCalls += 1; },
  });
  const resumed = await harness.api.resume();

  assert.equal(resumed, true);
  assert.equal(harness.portMessages('play').length, 1);
  assert.equal(autoplayStartedCalls, 0);

  await harness.api.pause();
  assert.equal(harness.api.snapshot().paused, true);

  resolveRestoreResume();
  await harness.settle();

  assert.equal(harness.engine.roles.current, restored);
  assert.equal(harness.api.snapshot().paused, true);
  assert.equal(harness.portMessages('play').length, 1);
  assert.equal(autoplayStartedCalls, 0);
});

test('concurrent restore and manual resume post play exactly once', async () => {
  let resolveResume;
  const resumeGate = new Promise((resolve) => {
    resolveResume = resolve;
  });
  const harness = createEngineHarness({
    resumeContext: () => resumeGate,
    clearTimeout: () => {},
    setTimeout: () => 1,
  });

  const startPromise = harness.api.start(makeTrack('03.flac'), {
    autoplay: true,
    allowSuspendedAutoplayFallback: true,
  });
  await harness.settle();
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  const deferredCurrentFrames = harness.engine.deferredCreditFrames.current;
  const pendingTrack = makeTrack('04.flac');
  harness.engine.roles.current.firstFrameNotified = true;
  harness.engine.diagnostics.firstFrameAtMs = 1;
  harness.engine.pendingContinuityTrack = pendingTrack;
  harness.engine.pendingContinuityOptions = {
    kind: 'queued-next', startSeconds: 0, endSeconds: 0,
  };
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  const manualResumePromise = harness.api.resume();
  await harness.settle();

  resolveResume();
  const [restored, manuallyResumed] = await Promise.all([startPromise, manualResumePromise]);

  assert.equal(manuallyResumed, true);
  assert.equal(harness.engine.roles.current, restored);
  assert.equal(harness.contexts[0].state, 'running');
  assert.equal(harness.api.snapshot().paused, false);
  assert.equal(harness.api.snapshot().mode, 'starting');
  assert.equal(harness.portMessages('play').length, 1);
  assert.equal(
    harness.sent('credit').filter(({ streamId }) => streamId === current.streamId).length,
    1,
    'deferred current credit is granted exactly once',
  );
  assert.ok(deferredCurrentFrames > 0);
  assert.equal(harness.engine.deferredCreditFrames.current, 0);
  assert.equal(
    harness.sent('open').filter(({ path }) => path === pendingTrack.path).length,
    1,
    'pending continuity is scheduled exactly once',
  );
});

test('restore-only autoplay posts play once when resume settles before its fallback boundary', async () => {
  let settlementScheduled = false;
  const harness = createEngineHarness({
    clearTimeout: () => {},
    setTimeout: () => {
      settlementScheduled = true;
      return 1;
    },
  });
  let autoplayStartedCalls = 0;

  const started = await harness.api.start(makeTrack('03.flac'), {
    autoplay: true,
    allowSuspendedAutoplayFallback: true,
    onAutoplayStarted: () => { autoplayStartedCalls += 1; },
  });

  assert.equal(settlementScheduled, true);
  assert.equal(harness.portMessages('play').length, 1);
  assert.equal(harness.api.snapshot().paused, false);
  assert.equal(harness.engine.roles.current, started);
  assert.equal(autoplayStartedCalls, 1);
});

test('ordinary autoplay keeps waiting for a pending resume without scheduling restore fallback', async () => {
  let resolveResume;
  const resumeGate = new Promise((resolve) => {
    resolveResume = resolve;
  });
  let settlementScheduled = false;
  const harness = createEngineHarness({
    resumeContext: () => resumeGate,
    clearTimeout: () => {},
    setTimeout: () => {
      settlementScheduled = true;
      return 1;
    },
  });
  let settled = false;

  const startPromise = harness.api.start(makeTrack('03.flac'), { autoplay: true })
    .then((role) => {
      settled = true;
      return role;
    });
  await harness.settle();

  assert.equal(settled, false);
  assert.equal(settlementScheduled, false);
  assert.equal(harness.portMessages('play').length, 0);

  resolveResume();
  const started = await startPromise;

  assert.equal(started.generation, 1);
  assert.equal(harness.portMessages('play').length, 1);
  assert.equal(harness.api.snapshot().paused, false);
});

test('pending restore fallback rejects error and stale role identities', async (t) => {
  for (const fixture of [
    {
      name: 'error mode',
      invalidate(harness) {
        harness.engine.mode = 'error';
      },
    },
    {
      name: 'stale role',
      invalidate(harness) {
        harness.engine.roles.current = null;
      },
    },
  ]) {
    await t.test(fixture.name, async () => {
      let resolveResume;
      const resumeGate = new Promise((resolve) => {
        resolveResume = resolve;
      });
      let harness;
      let autoplayStartedCalls = 0;
      harness = createEngineHarness({
        resumeContext: () => resumeGate,
        clearTimeout: () => {},
        setTimeout: (callback) => {
          fixture.invalidate(harness);
          queueMicrotask(callback);
          return 1;
        },
      });

      const restored = await harness.api.start(makeTrack('03.flac'), {
        autoplay: true,
        allowSuspendedAutoplayFallback: true,
        onAutoplayStarted: () => { autoplayStartedCalls += 1; },
      });

      assert.equal(restored, null);
      assert.equal(harness.portMessages('play').length, 0);
      assert.equal(harness.api.snapshot().paused, true);

      resolveResume();
      await harness.settle();
      assert.equal(harness.portMessages('play').length, 0);
      assert.equal(autoplayStartedCalls, 0);
    });
  }
});

test('restore-only autoplay fallback does not retain a role when resume enters error mode', async () => {
  const harness = createEngineHarness({
    resumeLeavesSuspended: true,
    resumeContext: () => {
      harness.engine.mode = 'error';
    },
  });

  const restored = await harness.api.start(makeTrack('03.flac'), {
    autoplay: true,
    allowSuspendedAutoplayFallback: true,
  });

  assert.equal(restored, null);
  assert.equal(harness.engine.mode, 'error');
  assert.equal(harness.portMessages('play').length, 0);
  assert.equal(harness.api.snapshot().paused, true);
});

test('default and explicit autoplay true resume the fresh generation', async (t) => {
  for (const fixture of [
    { name: 'default autoplay', options: undefined },
    { name: 'explicit autoplay', options: { autoplay: true } },
  ]) {
    await t.test(fixture.name, async () => {
      const harness = createEngineHarness();
      const started = fixture.options
        ? await harness.api.start(makeTrack('01.flac'), fixture.options)
        : await harness.api.start(makeTrack('01.flac'));

      assert.equal(harness.contexts[0].resumeCalls, 1);
      assert.equal(
        harness.portMessages('play').filter(({ generation }) => generation === started.generation).length,
        1,
      );
      assert.equal(harness.api.snapshot().paused, false);
    });
  }
});

test('paused metadata and consumption update accounting without credit until explicit resume', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('01.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    samples: [0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4],
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const continuity = harness.sent('open')[1];
  harness.engine.diagnostics.bufferedFrames.current = 4;
  await harness.api.pause();
  const creditsBeforePausedEvents = harness.sent('credit').length;

  acceptMetadata(harness, continuity);
  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    frames: 4,
    bufferedFrames: 0,
  });

  assert.equal(harness.sent('credit').length, creditsBeforePausedEvents);
  assert.equal(harness.api.snapshot().diagnostics.bufferedFrames.current, 0);
  assert.equal(harness.api.snapshot().diagnostics.inFlightFrames.continuity, 0);

  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.resume();

  const resumedCredits = harness.sent('credit').slice(creditsBeforePausedEvents);
  assert.deepEqual(new Set(resumedCredits.map(({ streamId }) => streamId)), new Set([
    continuity.streamId,
  ]));
  assert.ok(
    harness.api.snapshot().diagnostics.inFlightFrames.current > 0,
    'the current role keeps its already reserved ingress credit while paused',
  );
  const diagnostics = harness.api.snapshot().diagnostics;
  assert.ok(diagnostics.inFlightFrames.current <= 12 * 48_000);
  assert.ok(diagnostics.inFlightFrames.continuity <= 5 * 48_000);
});

test('unexpected socket close is inspectable while intentional stop remains stopped without an error', async () => {
  const failed = createEngineHarness();
  await failed.api.start(makeTrack());
  failed.sockets[0].unexpectedClose({ code: 1006, reason: 'network disappeared' });
  await failed.settle();

  const failedSnapshot = failed.api.snapshot();
  assert.equal(failedSnapshot.mode, 'error');
  assert.equal(failedSnapshot.diagnostics.lastError.source, 'socket');
  assert.match(failedSnapshot.diagnostics.lastError.message, /1006|network disappeared/);
  assert.equal(failed.portMessages('stop').length, 1);
  assert.equal(failed.nodes[0].disconnectCalls, 1);
  assert.equal(failed.contexts[0].closeCalls, 1);
  assert.equal(failed.engine.context, null);
  assert.equal(failed.engine.node, null);
  assert.equal(failed.engine.socket, null);

  const stopped = createEngineHarness();
  await stopped.api.start(makeTrack());
  await stopped.api.stop('owner-stop');

  const stoppedSnapshot = stopped.api.snapshot();
  assert.equal(stoppedSnapshot.mode, 'stopped');
  assert.equal(stoppedSnapshot.diagnostics.lastError, undefined);
});

test('concurrent prepare calls share one in-flight context, worklet, node, and socket', async () => {
  let releaseModule;
  const moduleGate = new Promise((resolve) => {
    releaseModule = resolve;
  });
  const harness = createEngineHarness({ addModule: () => moduleGate });

  const firstPrepare = harness.api.prepare();
  const secondPrepare = harness.api.prepare();
  releaseModule();
  await Promise.all([firstPrepare, secondPrepare]);
  await harness.settle();

  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.contexts[0].audioWorklet.modules.length, 1);
  assert.equal(harness.nodes.length, 1);
  assert.equal(harness.sockets.length, 1);
});

test('failed worklet preparation closes partial context and leaves no engine references', async () => {
  const loadError = new Error('worklet module rejected');
  const harness = createEngineHarness({
    addModule: async () => {
      throw loadError;
    },
  });

  await assert.rejects(harness.api.prepare(), loadError);

  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.engine.context, null);
  assert.equal(harness.engine.node, null);
  assert.equal(harness.engine.socket, null);
  assert.equal(harness.api.snapshot().mode, 'stopped');
});

test('stop racing deferred preparation waits for and exactly cleans the completed resources', async () => {
  let releaseModule;
  const moduleGate = new Promise((resolve) => {
    releaseModule = resolve;
  });
  const harness = createEngineHarness({ addModule: () => moduleGate });

  const preparation = harness.api.prepare();
  const stopping = harness.api.stop('prepare-cancelled');
  releaseModule();
  await Promise.all([preparation, stopping]);
  await harness.settle();

  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.nodes.length, 1);
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.portMessages('stop').length, 1);
  assert.equal(harness.nodes[0].disconnectCalls, 1);
  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.engine.context, null);
  assert.equal(harness.engine.node, null);
  assert.equal(harness.engine.socket, null);
  assert.equal(harness.api.snapshot().mode, 'stopped');
});

test('start waits for blocked stop cleanup and uses one fresh resource set', async () => {
  let releaseFirstClose;
  let markFirstCloseStarted;
  const firstCloseGate = new Promise((resolve) => {
    releaseFirstClose = resolve;
  });
  const firstCloseStarted = new Promise((resolve) => {
    markFirstCloseStarted = resolve;
  });
  const harness = createEngineHarness({
    closeContext: async (context) => {
      if (context !== harness.contexts[0]) return;
      markFirstCloseStarted();
      await firstCloseGate;
    },
  });
  const oldTrack = makeTrack('01.flac');
  const newTrack = makeTrack('02.flac');
  await harness.api.start(oldTrack);
  const oldSocket = harness.sockets[0];

  const stopping = harness.api.stop('replacement');
  await firstCloseStarted;
  const starting = harness.api.start(newTrack);
  await harness.settle();

  assert.equal(harness.contexts.length, 1);
  assert.deepEqual(oldSocket.sent.filter(({ type }) => type === 'open').map(({ path }) => path), [
    oldTrack.path,
  ]);

  releaseFirstClose();
  await Promise.all([stopping, starting]);
  await harness.settle();

  assert.equal(harness.contexts.length, 2);
  assert.equal(harness.nodes.length, 2);
  assert.equal(harness.sockets.length, 2);
  assert.deepEqual(
    harness.sockets[1].sent.filter(({ type }) => type === 'open').map(({ path }) => path),
    [newTrack.path],
  );
  assert.equal(harness.contexts[0].state, 'closed');
  assert.equal(harness.contexts[1].state, 'running');
  const snapshot = harness.api.snapshot();
  assert.equal(snapshot.src, newTrack.src);
  assert.deepEqual([...snapshot.diagnostics.activeRoles], ['current']);
});

test('processor and server stream errors clean resources while preserving their diagnostics', async (t) => {
  for (const failure of [
    {
      name: 'processor error',
      source: 'processor',
      message: 'render thread crashed',
      trigger(harness) {
        harness.nodes[0].fail(new Error(this.message));
      },
    },
    {
      name: 'server stream error',
      source: 'socket',
      message: 'decoder exited with code 1',
      trigger(harness, current) {
        harness.sockets[0].receive({
          type: 'error',
          generation: current.generation,
          streamId: current.streamId,
          role: 'current',
          code: 'decoder_failed',
          message: this.message,
          recoverable: false,
        });
      },
    },
  ]) {
    await t.test(failure.name, async () => {
      const harness = createEngineHarness();
      await harness.api.start(makeTrack());
      const current = harness.sent('open')[0];

      failure.trigger(harness, current);

      const immediate = harness.api.snapshot();
      assert.equal(immediate.mode, 'error');
      assert.equal(immediate.diagnostics.lastError.source, failure.source);
      assert.match(immediate.diagnostics.lastError.message, new RegExp(failure.message));

      await harness.settle();

      const settled = harness.api.snapshot();
      assert.equal(harness.portMessages('stop').length, 1);
      assert.equal(harness.nodes[0].disconnectCalls, 1);
      assert.equal(harness.sockets[0].closeCalls, 1);
      assert.equal(harness.contexts[0].closeCalls, 1);
      assert.equal(harness.engine.context, null);
      assert.equal(harness.engine.node, null);
      assert.equal(harness.engine.socket, null);
      assert.deepEqual([...settled.diagnostics.activeRoles], []);
      assert.equal(settled.mode, 'error');
      assert.equal(settled.diagnostics.lastError.source, failure.source);
      assert.match(settled.diagnostics.lastError.message, new RegExp(failure.message));
    });
  }
});

test('active-generation worklet protocol rejection is fatal while an earlier-generation rejection stays stale', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('01.flac'));
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const continuity = harness.sent('open')[1];

  harness.nodes[0].port.dispatch({
    type: 'protocol-reject',
    generation: current.generation - 1,
    operation: 'enqueue',
    reason: 'sequence',
    role: 'current',
    streamId: current.streamId,
    sequence: 1,
  });
  const staleBeforeActiveReject = harness.api.snapshot().diagnostics.staleMessages;
  assert.equal(staleBeforeActiveReject, 1, 'an earlier-generation rejection remains harmless');

  harness.nodes[0].port.dispatch({
    type: 'protocol-reject',
    generation: current.generation,
    operation: 'enqueue',
    reason: 'sequence',
    role: 'current',
    streamId: current.streamId,
    sequence: 1,
  });

  const immediate = harness.api.snapshot();
  assert.equal(immediate.mode, 'error');
  assert.equal(immediate.paused, true);
  assert.equal(immediate.diagnostics.lastError.source, 'processor');
  assert.match(immediate.diagnostics.lastError.message, /protocol|enqueue|sequence/i);
  assert.equal(immediate.diagnostics.staleMessages, staleBeforeActiveReject);

  await harness.settle();

  const settled = harness.api.snapshot();
  assert.deepEqual(
    harness.sent('close').map(({ generation, streamId }) => ({ generation, streamId })),
    [
      { generation: current.generation, streamId: current.streamId },
      { generation: continuity.generation, streamId: continuity.streamId },
    ],
  );
  assert.equal(harness.portMessages('stop').length, 1);
  assert.equal(harness.nodes[0].disconnectCalls, 1);
  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.engine.context, null);
  assert.equal(harness.engine.node, null);
  assert.equal(harness.engine.socket, null);
  assert.deepEqual([...settled.diagnostics.activeRoles], []);
  assert.equal(settled.mode, 'error');
  assert.equal(settled.paused, true);
  assert.equal(settled.diagnostics.staleMessages, staleBeforeActiveReject);
});

test('same-generation worklet rejection from a retired outgoing stream stays stale after prepared replacement', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('01.flac'));
  const outgoing = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));

  const starting = harness.api.start(makeTrack('03.flac'));
  const replacement = harness.sent('open').at(-1);
  acceptMetadata(harness, replacement);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: replacement.generation,
    streamId: replacement.streamId,
    sequence: 0,
    samples: new Array(12_000 * 2).fill(0.5),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: replacement.generation,
    outgoingStreamId: outgoing.streamId,
    incomingStreamId: replacement.streamId,
    renderedFrame: 128,
    timelineFrame: 0,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  const promoted = await starting;
  assert.equal(outgoing.streamId, 1);
  assert.equal(replacement.streamId, 3);
  assert.equal(promoted.streamId, replacement.streamId);
  assert.equal(harness.engine.roles.current.streamId, replacement.streamId);

  const staleBeforeRetiredReject = harness.api.snapshot().diagnostics.staleMessages;
  harness.nodes[0].port.dispatch({
    type: 'protocol-reject',
    generation: replacement.generation,
    operation: 'enqueue',
    reason: 'identity',
    role: 'current',
    streamId: outgoing.streamId,
    sequence: 1,
    ringStreamId: replacement.streamId,
  });

  const afterRetiredReject = harness.api.snapshot();
  assert.equal(afterRetiredReject.mode, 'playing');
  assert.equal(afterRetiredReject.diagnostics.staleMessages, staleBeforeRetiredReject + 1);
  assert.equal(harness.engine.roles.current.streamId, replacement.streamId);
  assert.equal(harness.portMessages('stop').length, 0);
  assert.equal(harness.nodes[0].disconnectCalls, 0);
  assert.equal(harness.sockets[0].closeCalls, 0);
  assert.equal(harness.contexts[0].closeCalls, 0);

  const closeCountBeforeActiveReject = harness.sent('close').length;
  harness.nodes[0].port.dispatch({
    type: 'protocol-reject',
    generation: replacement.generation,
    operation: 'enqueue',
    reason: 'identity',
    role: 'current',
    streamId: replacement.streamId,
    sequence: 1,
    ringStreamId: replacement.streamId,
  });

  const immediate = harness.api.snapshot();
  assert.equal(immediate.mode, 'error');
  assert.equal(immediate.paused, true);
  assert.equal(immediate.diagnostics.lastError.source, 'processor');
  assert.match(immediate.diagnostics.lastError.message, /protocol|enqueue|identity/i);
  assert.equal(immediate.diagnostics.staleMessages, staleBeforeRetiredReject + 1);

  await harness.settle();

  const settled = harness.api.snapshot();
  assert.deepEqual(
    harness.sent('close')
      .slice(closeCountBeforeActiveReject)
      .map(({ generation, streamId }) => ({ generation, streamId })),
    [{ generation: replacement.generation, streamId: replacement.streamId }],
  );
  assert.equal(harness.portMessages('stop').length, 1);
  assert.equal(harness.nodes[0].disconnectCalls, 1);
  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.engine.context, null);
  assert.equal(harness.engine.node, null);
  assert.equal(harness.engine.socket, null);
  assert.deepEqual([...settled.diagnostics.activeRoles], []);
  assert.equal(settled.mode, 'error');
  assert.equal(settled.paused, true);
});

test('deferred continuity microtasks cannot cross a synchronous generation change', async (t) => {
  for (const scenario of [
    {
      name: 'first-frame pending next followed by seek',
      async prepare(harness) {
        await harness.api.continuity(makeTrack('02.flac'));
        return { expectedCurrentTrack: makeTrack('01.flac') };
      },
      trigger(harness, current) {
        harness.nodes[0].port.dispatch({
          type: 'first-frame',
          generation: current.generation,
          streamId: current.streamId,
          renderedFrame: 0,
          contextTime: 12.5,
        });
        return harness.api.seek(30);
      },
    },
    {
      name: 'promoted-ack pending replacement followed by seek',
      async prepare(harness, current) {
        harness.nodes[0].port.dispatch({
          type: 'first-frame',
          generation: current.generation,
          streamId: current.streamId,
          renderedFrame: 0,
          contextTime: 12.5,
        });
        harness.engine.diagnostics.bufferedFrames.current = 48_000;
        await harness.api.continuity(makeTrack('02.flac'));
        const continuity = harness.sent('open')[1];
        harness.nodes[0].port.dispatch({
          type: 'boundary',
          generation: current.generation,
          outgoingStreamId: current.streamId,
          incomingStreamId: continuity.streamId,
          renderedFrame: 11_520_000,
          capture: null,
        });
        await harness.api.continuity(makeTrack('03.flac'));
        return {
          continuity,
          expectedCurrentTrack: makeTrack('02.flac'),
        };
      },
      trigger(harness, current, { continuity }) {
        harness.sockets[0].receive({
          type: 'promoted',
          generation: current.generation,
          streamId: continuity.streamId,
          role: 'current',
        });
        return harness.api.seek(30);
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const harness = createEngineHarness();
      await harness.api.start(makeTrack('01.flac'));
      const current = harness.sent('open')[0];
      const setup = await scenario.prepare(harness, current);
      const openOffset = harness.sent('open').length;

      const seeking = scenario.trigger(harness, current, setup);
      await seeking;
      await harness.settle();
      const replacement = harness.sent('open').at(-1);
      const seekOpens = harness.sent('open').slice(openOffset);
      assert.deepEqual(
        seekOpens.map(({ role, path }) => ({ role, path })),
        [{ role: 'continuity', path: setup.expectedCurrentTrack.path }],
      );
      assert.equal(replacement.generation, current.generation);
      assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current', 'continuity']);
    });
  }
});

test('an error from a stopped old socket cannot poison the replacement session', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('01.flac'));
  const oldSocket = harness.sockets[0];

  await harness.api.stop('replacement');
  const replacementTrack = makeTrack('02.flac');
  await harness.api.start(replacementTrack);
  const replacementSocket = harness.sockets[1];
  const replacementContext = harness.contexts[1];

  oldSocket.fail(new Error('late error from socket 1'));

  const snapshot = harness.api.snapshot();
  assert.equal(replacementSocket.readyState, 1);
  assert.equal(replacementContext.state, 'running');
  assert.equal(harness.nodes[1].connections[0], replacementContext.destination);
  assert.equal(snapshot.mode, 'starting');
  assert.equal(snapshot.src, replacementTrack.src);
  assert.deepEqual([...snapshot.diagnostics.activeRoles], ['current']);
  assert.equal(snapshot.diagnostics.lastError, undefined);
});

test('stop attempts every teardown and clears state before rejecting all cleanup failures', async () => {
  const failures = {
    processor: new Error('processor stop postMessage failed'),
    node: new Error('node disconnect failed'),
    socket: new Error('socket close failed'),
    context: new Error('context close failed'),
  };
  const harness = createEngineHarness({
    stopPostMessage: () => { throw failures.processor; },
    disconnectNode: () => { throw failures.node; },
    closeSocket: () => { throw failures.socket; },
    closeContext: async () => { throw failures.context; },
  });
  await harness.api.start(makeTrack());

  let rejection;
  try {
    await harness.api.stop('teardown-failure');
  } catch (error) {
    rejection = error;
  }

  assert.ok(rejection, 'cleanup failures must reject stop');
  assert.deepEqual(
    [...(rejection.errors || [])].map((error) => error.message).sort(),
    Object.values(failures).map((error) => error.message).sort(),
  );
  assert.equal(harness.portMessages('stop').length, 1);
  assert.equal(harness.nodes[0].disconnectCalls, 1);
  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.engine.context, null);
  assert.equal(harness.engine.node, null);
  assert.equal(harness.engine.socket, null);
  assert.equal(harness.engine.roles.current, null);
  assert.equal(harness.engine.roles.continuity, null);
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], []);
  assert.deepEqual({
    bufferedCurrent: harness.engine.diagnostics.bufferedFrames.current,
    bufferedContinuity: harness.engine.diagnostics.bufferedFrames.continuity,
    inFlightCurrent: harness.engine.diagnostics.inFlightFrames.current,
    inFlightContinuity: harness.engine.diagnostics.inFlightFrames.continuity,
    deferredCurrent: harness.engine.deferredCreditFrames.current,
    deferredContinuity: harness.engine.deferredCreditFrames.continuity,
  }, {
    bufferedCurrent: 0,
    bufferedContinuity: 0,
    inFlightCurrent: 0,
    inFlightContinuity: 0,
    deferredCurrent: 0,
    deferredContinuity: 0,
  });
  const snapshot = harness.api.snapshot();
  assert.deepEqual(
    Object.fromEntries(
      ['currentTime', 'duration', 'paused', 'ended', 'src', 'readyState']
        .map((key) => [key, snapshot[key]]),
    ),
    {
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
      src: '',
      readyState: 0,
    },
  );
});

test('prepare preserves its primary rejection while exposing context cleanup failure', async () => {
  const primaryFailure = new Error('worklet addModule failed');
  const cleanupFailure = new Error('partial context close failed');
  const harness = createEngineHarness({
    addModule: async () => { throw primaryFailure; },
    closeContext: async () => { throw cleanupFailure; },
  });

  let rejection;
  try {
    await harness.api.prepare();
  } catch (error) {
    rejection = error;
  }

  assert.equal(rejection, primaryFailure);
  const cleanupErrors = rejection.cleanupErrors || rejection.cause?.errors || [];
  assert.deepEqual(
    [...cleanupErrors].map((error) => error.message),
    [cleanupFailure.message],
  );
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.engine.context, null);
  assert.equal(harness.engine.node, null);
  assert.equal(harness.engine.socket, null);
  assert.equal(harness.api.snapshot().mode, 'stopped');
});

test('malformed active-stream PCM fails loudly and cleans resources without becoming stale', async (t) => {
  for (const malformed of [
    {
      name: 'bad magic',
      mutate: (view) => view.setUint8(0, 0),
    },
    {
      name: 'bad version',
      mutate: (view) => view.setUint8(4, 2),
    },
    {
      name: 'invalid role code',
      mutate: (view) => view.setUint8(5, 2),
    },
    {
      name: 'nonzero flags',
      mutate: (view) => view.setUint16(6, 1, false),
    },
    {
      name: 'mismatched declared length',
      mutate: (view) => view.setUint32(20, 2, false),
    },
    {
      name: 'out-of-credit frame',
      mutate: (_view, harness) => {
        harness.engine.diagnostics.inFlightFrames.current = 0;
      },
    },
  ]) {
    await t.test(malformed.name, async () => {
      const harness = createEngineHarness();
      await harness.api.start(makeTrack());
      const current = harness.sent('open')[0];
      acceptMetadata(harness, current);
      const staleBefore = harness.api.snapshot().diagnostics.staleMessages;
      const malformedPcm = createPcmMessage({
        generation: current.generation,
        streamId: current.streamId,
        samples: [0.25, -0.5],
      });
      malformed.mutate(new DataView(malformedPcm), harness);

      harness.sockets[0].receive(malformedPcm);

      const immediate = harness.api.snapshot();
      assert.equal(immediate.mode, 'error');
      assert.equal(immediate.diagnostics.lastError.source, 'socket');
      assert.match(immediate.diagnostics.lastError.message, /PCM|protocol|credit/i);
      assert.equal(immediate.diagnostics.staleMessages, staleBefore);
      assert.equal(immediate.diagnostics.pcmEvidence.frames, 0);
      assert.equal(immediate.diagnostics.pcmEvidence.nonZeroSamples, 0);

      await harness.settle();

      const settled = harness.api.snapshot();
      assert.equal(harness.portMessages('stop').length, 1);
      assert.equal(harness.nodes[0].disconnectCalls, 1);
      assert.equal(harness.sockets[0].closeCalls, 1);
      assert.equal(harness.contexts[0].closeCalls, 1);
      assert.equal(harness.engine.context, null);
      assert.equal(harness.engine.node, null);
      assert.equal(harness.engine.socket, null);
      assert.equal(settled.mode, 'error');
      assert.equal(settled.diagnostics.staleMessages, staleBefore);
      assert.deepEqual([...settled.diagnostics.activeRoles], []);
    });
  }
});

test('invalid active control protocol fails loudly and cleans resources with diagnostics intact', async (t) => {
  for (const invalid of [
    {
      name: 'invalid metadata',
      trigger(harness, current) {
        harness.sockets[0].receive({
          type: 'metadata',
          generation: current.generation,
          streamId: current.streamId,
          role: 'current',
          sampleRate: 44_100,
          channels: 2,
          provisionalTotalFrames: 11_520_000,
          requestedStartFrame: current.startFrame,
          timelineStartFrame: current.startFrame,
        });
      },
      message: /metadata/i,
    },
    {
      name: 'invalid end of stream',
      prepare: acceptMetadata,
      trigger(harness, current) {
        harness.sockets[0].receive({
          type: 'eos',
          generation: current.generation,
          streamId: current.streamId,
          role: 'current',
          emittedFrames: 48_000,
          authoritativeTotalFrames: 47_999,
        });
      },
      message: /end.of.stream|eos/i,
    },
    {
      name: 'malformed JSON',
      trigger(harness) {
        harness.sockets[0].receiveText('{"type":"metadata"');
      },
      message: /JSON|unexpected|parse|position/i,
    },
  ]) {
    await t.test(invalid.name, async () => {
      const harness = createEngineHarness();
      await harness.api.start(makeTrack());
      const current = harness.sent('open')[0];
      invalid.prepare?.(harness, current);

      invalid.trigger(harness, current);

      const immediate = harness.api.snapshot();
      assert.equal(immediate.mode, 'error');
      assert.equal(immediate.diagnostics.lastError.source, 'socket');
      assert.match(immediate.diagnostics.lastError.message, invalid.message);

      await harness.settle();

      const settled = harness.api.snapshot();
      assert.equal(harness.portMessages('stop').length, 1);
      assert.equal(harness.nodes[0].disconnectCalls, 1);
      assert.equal(harness.sockets[0].closeCalls, 1);
      assert.equal(harness.contexts[0].closeCalls, 1);
      assert.equal(harness.engine.context, null);
      assert.equal(harness.engine.node, null);
      assert.equal(harness.engine.socket, null);
      assert.deepEqual([...settled.diagnostics.activeRoles], []);
      assert.equal(settled.mode, 'error');
      assert.equal(settled.diagnostics.lastError.source, 'socket');
      assert.match(settled.diagnostics.lastError.message, invalid.message);
    });
  }
});

test('authoritative current EOS corrects duration and permanently closes its credit window', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    samples: [0.25, -0.5, 0.75, -1],
  });

  harness.sockets[0].receive({
    type: 'eos',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    emittedFrames: 2,
    authoritativeTotalFrames: 2,
  });

  const afterEos = harness.api.snapshot();
  assert.equal(afterEos.duration, 2 / 48_000);
  assert.equal(afterEos.diagnostics.inFlightFrames.current, 0);
  assert.equal(harness.engine.roles.current.eosReceived, true);
  assert.deepEqual(
    harness.portMessages('eos').map((message) => ({
      generation: message.generation,
      streamId: message.streamId,
      role: message.role,
      emittedFrames: message.emittedFrames,
      authoritativeTotalFrames: message.authoritativeTotalFrames,
    })),
    [{
      generation: current.generation,
      streamId: current.streamId,
      role: 'current',
      emittedFrames: 2,
      authoritativeTotalFrames: 2,
    }],
  );
  const creditsAtEos = harness.sent('credit').length;

  harness.nodes[0].port.dispatch({
    type: 'consumed',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    frames: 2,
    bufferedFrames: 0,
  });

  assert.equal(harness.sent('credit').length, creditsAtEos);
  assert.equal(harness.api.snapshot().diagnostics.inFlightFrames.current, 0);
  assert.equal(harness.api.snapshot().diagnostics.bufferedFrames.current, 0);
  assert.ok(harness.api.snapshot().diagnostics.bufferedFrames.current <= 12 * 48_000);
});

test('restart waits through failed stop cleanup and then starts on one fresh resource set', async () => {
  const cleanupFailure = new Error('old context close failed');
  const harness = createEngineHarness({
    closeContext: async (context) => {
      if (context === harness.contexts[0]) throw cleanupFailure;
    },
  });
  const oldTrack = makeTrack('01.flac');
  const newTrack = makeTrack('02.flac');
  await harness.api.start(oldTrack);

  const stopping = harness.api.stop('replacement');
  const restarting = harness.api.start(newTrack);
  let stopRejection;
  try {
    await stopping;
  } catch (error) {
    stopRejection = error;
  }
  await restarting;
  await harness.settle();

  assert.ok(stopRejection, 'failed teardown must remain reported to the stop caller');
  assert.deepEqual(
    [...(stopRejection.errors || [])].map((error) => error.message),
    [cleanupFailure.message],
  );
  assert.equal(harness.contexts.length, 2);
  assert.equal(harness.nodes.length, 2);
  assert.equal(harness.sockets.length, 2);
  assert.deepEqual(
    harness.sockets[1].sent.filter(({ type }) => type === 'open').map(({ path }) => path),
    [newTrack.path],
  );
  assert.equal(harness.contexts[1].state, 'running');
  const snapshot = harness.api.snapshot();
  assert.equal(snapshot.mode, 'starting');
  assert.equal(snapshot.src, newTrack.src);
  assert.deepEqual([...snapshot.diagnostics.activeRoles], ['current']);
});

test('failed credit send is fatal without reserving frames and preserves its diagnostic through cleanup', async () => {
  const sendFailure = new Error('credit socket send failed');
  const harness = createEngineHarness({
    sendSocket(message) {
      if (message.type === 'credit') throw sendFailure;
    },
  });
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];

  acceptMetadata(harness, current);

  const immediate = harness.api.snapshot();
  assert.equal(immediate.mode, 'error');
  assert.equal(immediate.diagnostics.lastError.source, 'socket');
  assert.match(immediate.diagnostics.lastError.message, /credit socket send failed/);
  assert.equal(immediate.diagnostics.inFlightFrames.current, 0);
  assert.equal(harness.sent('credit').length, 1, 'attempted credit control remains inspectable');

  await harness.settle();

  const settled = harness.api.snapshot();
  assert.equal(harness.portMessages('stop').length, 1);
  assert.equal(harness.nodes[0].disconnectCalls, 1);
  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.engine.context, null);
  assert.equal(harness.engine.node, null);
  assert.equal(harness.engine.socket, null);
  assert.equal(harness.engine.roles.current, null);
  assert.equal(harness.engine.roles.continuity, null);
  assert.deepEqual([...settled.diagnostics.activeRoles], []);
  assert.equal(settled.mode, 'error');
  assert.equal(settled.diagnostics.lastError.source, 'socket');
  assert.match(settled.diagnostics.lastError.message, /credit socket send failed/);
});

test('open and replacement-close send failures abort start and clean the exact session', async (t) => {
  await t.test('initial open send failure', async () => {
    const sendFailure = new Error('initial open send failed');
    const harness = createEngineHarness({
      sendSocket(message) {
        if (message.type === 'open') throw sendFailure;
      },
    });

    await assert.doesNotReject(harness.api.start(makeTrack('01.flac')));
    assert.equal(harness.api.snapshot().mode, 'error');
    assert.match(harness.api.snapshot().diagnostics.lastError.message, /initial open send failed/);
    await harness.settle();

    assert.equal(harness.portMessages('stop').length, 1);
    assert.equal(harness.nodes[0].disconnectCalls, 1);
    assert.equal(harness.sockets[0].closeCalls, 1);
    assert.equal(harness.contexts[0].closeCalls, 1);
    assert.equal(harness.engine.context, null);
    assert.equal(harness.engine.node, null);
    assert.equal(harness.engine.socket, null);
    assert.equal(harness.api.snapshot().mode, 'error');
  });

  await t.test('replacement close send failure', async () => {
    let failReplacementClose = false;
    const sendFailure = new Error('replacement close send failed');
    const harness = createEngineHarness({
      sendSocket(message) {
        if (failReplacementClose && message.type === 'close') throw sendFailure;
      },
    });
    await harness.api.start(makeTrack('01.flac'));
    const originalGeneration = harness.api.snapshot().generation;
    failReplacementClose = true;

    await assert.doesNotReject(harness.api.start(makeTrack('02.flac')));

    const immediate = harness.api.snapshot();
    assert.equal(immediate.mode, 'error');
    assert.match(immediate.diagnostics.lastError.message, /replacement close send failed/);
    assert.equal(immediate.generation, originalGeneration);
    assert.deepEqual(harness.sent('open').map(({ path }) => path), [makeTrack('01.flac').path]);
    await harness.settle();
    assert.equal(harness.portMessages('stop').length, 1);
    assert.equal(harness.nodes[0].disconnectCalls, 1);
    assert.equal(harness.sockets[0].closeCalls, 1);
    assert.equal(harness.contexts[0].closeCalls, 1);
    assert.equal(harness.engine.context, null);
    assert.equal(harness.engine.node, null);
    assert.equal(harness.engine.socket, null);
    assert.equal(harness.api.snapshot().mode, 'error');
  });
});

test('a resume resolved after stop cannot post to old resources or affect a fresh session', async () => {
  let releaseOldResume;
  let markOldResumeStarted;
  const oldResumeGate = new Promise((resolve) => { releaseOldResume = resolve; });
  const oldResumeStarted = new Promise((resolve) => { markOldResumeStarted = resolve; });
  const harness = createEngineHarness({
    resumeContext: async (context) => {
      if (context !== harness.contexts[0]) return;
      markOldResumeStarted();
      await oldResumeGate;
    },
  });
  const oldStart = harness.api.start(makeTrack('01.flac'));
  await oldResumeStarted;

  await harness.api.stop('replacement');
  const newTrack = makeTrack('02.flac');
  await harness.api.start(newTrack);
  const freshSnapshot = harness.api.snapshot();

  releaseOldResume();
  await assert.doesNotReject(oldStart);
  await harness.settle();

  assert.equal(harness.portMessages('play').filter((message) => message.generation === 1).length, 0);
  assert.equal(harness.nodes[0].port.messages.filter(({ message }) => message.type === 'play').length, 0);
  assert.equal(harness.nodes[1].port.messages.filter(({ message }) => message.type === 'play').length, 1);
  assert.equal(harness.engine.context, harness.contexts[1]);
  assert.equal(harness.engine.node, harness.nodes[1]);
  assert.equal(harness.engine.socket, harness.sockets[1]);
  const settled = harness.api.snapshot();
  assert.equal(settled.mode, freshSnapshot.mode);
  assert.equal(settled.src, newTrack.src);
  assert.deepEqual([...settled.diagnostics.activeRoles], ['current']);
});

test('unknown active-stream control type is a fatal socket protocol error', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];

  harness.sockets[0].receive({
    type: 'future-unknown-control',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
  });

  const immediate = harness.api.snapshot();
  assert.equal(immediate.mode, 'error');
  assert.equal(immediate.diagnostics.lastError.source, 'socket');
  assert.match(immediate.diagnostics.lastError.message, /unknown|protocol|control/i);
  await harness.settle();

  const settled = harness.api.snapshot();
  assert.equal(harness.portMessages('stop').length, 1);
  assert.equal(harness.nodes[0].disconnectCalls, 1);
  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.engine.context, null);
  assert.equal(harness.engine.node, null);
  assert.equal(harness.engine.socket, null);
  assert.deepEqual([...settled.diagnostics.activeRoles], []);
  assert.equal(settled.mode, 'error');
  assert.equal(settled.diagnostics.lastError.source, 'socket');
  assert.match(settled.diagnostics.lastError.message, /unknown|protocol|control/i);
});
