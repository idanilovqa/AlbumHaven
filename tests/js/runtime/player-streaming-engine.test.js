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
  (expectations.socket || harness.sockets[0]).receive(wirePcm);
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

class KnownTrackSampleRates extends Map {
  get() {
    return 48_000;
  }
}

function createEngineHarness(options = {}) {
  const intervals = [];
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
      this.processor?.port.onmessage({ data: message });
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
      if (options.realProcessor) {
        const port = this.port;
        const processorContext = {
          AudioWorkletProcessor: class {
            constructor() {
              this.port = { postMessage: (message) => port.events.push(message) };
            }
          },
          Float32Array, Math, Number, Object, currentTime: 12.5, sampleRate: 48_000,
          registerProcessor: (_name, Processor) => { port.processor = new Processor(); },
        };
        port.events = [];
        vm.createContext(processorContext);
        vm.runInContext(fs.readFileSync(path.join(repoRoot,
          'music_app/static/js/audio-worklets/gapless-playback-processor.js'), 'utf8'), processorContext);
        this.render = () => {
          const output = [new Float32Array(128), new Float32Array(128)];
          port.processor.process([], [output]);
          return output;
        };
        this.deliverEvents = () => {
          for (const event of port.events.splice(0)) port.dispatch(event);
        };
      }
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
    constructor({ sampleRate, latencyHint }) {
      this.state = 'suspended';
      this.sampleRate = sampleRate;
      this.latencyHint = latencyHint;
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
      this.probes = [];
      this.binaryType = '';
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.closeCalls = 0;
      sockets.push(this);
      // A refused connection never opens: the browser reports only its close.
      const refusal = options.refuseConnection?.(sockets.length);
      // A hanging connection neither opens nor closes.
      if (refusal === 'hang') {
        this.readyState = 0;
        return;
      }
      if (refusal) {
        this.readyState = 0;
        queueMicrotask(() => this.unexpectedClose({ code: refusal === true ? 1006 : refusal }));
        return;
      }
      queueMicrotask(() => this.onopen?.({}));
    }

    send(message) {
      const parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;
      if (parsedMessage.type === 'probe') {
        this.probes.push(parsedMessage);
        if (!options.holdSampleRateProbes) {
          queueMicrotask(() => this.receive({
            type: 'probe-result',
            requestId: parsedMessage.requestId,
            sampleRate: options.trackSampleRate?.(parsedMessage.path) ?? 48_000,
          }));
        }
        return;
      }
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

  const windowListeners = [];
  const window = {
    addEventListener: (type, listener) => windowListeners.push({ type, listener }),
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
    // Intervals only run when a test ticks them.
    setInterval: (callback, delay) => intervals.push({ callback, delay }),
    clearInterval: () => {},
    state: {
      player: {
        streaming: {
          mode: 'stopped',
          generation: 0,
          context: null,
          node: null,
          socket: null,
          roles: { current: null, continuity: null },
          trackSampleRates: options.trackSampleRates || new KnownTrackSampleRates(),
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
    createStreamingDecoder: options.createStreamingDecoder,
    probeCachedWaveformPeaks: options.probeCachedWaveformPeaks,
    handleStreamingPlaybackFirstFrame: options.handleStreamingPlaybackFirstFrame,
    handleStreamingPlaybackBoundary: options.handleStreamingPlaybackBoundary,
    handleStreamingPlaybackPosition: options.handleStreamingPlaybackPosition,
    handleStreamingPlaybackEnded: options.handleStreamingPlaybackEnded,
    handleStreamingPlaybackWaveformReady: options.handleStreamingPlaybackWaveformReady,
    ensureStreamingDecoders: options.ensureStreamingDecoders,
    getLocalStorageItem: options.getLocalStorageItem,
    setLocalStorageItem: options.setLocalStorageItem,
    updatePlayerUi: options.updatePlayerUi,
    fetch: options.fetch,
    cancelWaveformPeakLoads: options.cancelWaveformPeakLoads,
    probeCachedWaveformPeaks: options.probeCachedWaveformPeaks,
    ...(options.document ? { document: options.document } : {}),
    ...(options.requestAnimationFrame ? { requestAnimationFrame: options.requestAnimationFrame } : {}),
  };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(enginePath, 'utf8'), context, { filename: enginePath });
  // The player reaches the engine through its contract.
  const contractPath = path.join(path.dirname(enginePath), 'playback-engine.js');
  vm.runInContext(fs.readFileSync(contractPath, 'utf8'), context, { filename: contractPath });
  if (options.measuredListening) {
    Object.assign(context, { crypto: require('node:crypto'), isoNow: () => new Date().toISOString(), unixNowSeconds: () => Math.floor(Date.now()/1000), getPlayerPlaybackSnapshot: () => context.state.player.streaming.snapshot });
    vm.runInContext(fs.readFileSync(path.join(repoRoot, 'music_app/static/js/runtime/player-listen-session-helpers.js'), 'utf8'), context);
  }
  const api = vm.runInContext(`({
    prepare: (sampleRate = 48_000) => prepareStreamingPlaybackEngine(sampleRate),
    start: startStreamingTrack,
    pause: pauseStreamingPlayback,
    resume: resumeStreamingPlayback,
    reconcileInterruption: reconcileInterruptedStreamingPlayback,
    seek: seekStreamingPlayback,
    continuity: scheduleStreamingContinuity,
    setLoop: setStreamingLoop,
    stop: stopStreamingPlayback,
    snapshot: getStreamingPlaybackSnapshot,
  })`, context);

  return {
    context,
    api,
    contexts,
    intervals,
    dateNow: () => FakeDate.now(),
    engine: context.state.player.streaming,
    nodes,
    sockets,
    setNow(value) {
      now = value;
    },
    dispatchWindowEvent(type) {
      for (const entry of windowListeners) if (entry.type === type) entry.listener({ type });
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    sent(type) {
      return sockets.flatMap((socket) => socket.sent).filter((message) => message.type === type);
    },
    portMessages(type) {
      const matches = [];
      for (const node of nodes) {
        for (const { message } of node.port.messages) {
          if (message.type === type) matches.push(message);
        }
      }
      return matches;
    },
  };
}

test('first playback does not wait for background decoder verification', async () => {
  let finishDecoderVerification;
  const decoderVerification = new Promise((resolve) => {
    finishDecoderVerification = resolve;
  });
  const harness = createEngineHarness({
    ensureStreamingDecoders: () => decoderVerification,
  });

  const start = harness.api.start(makeTrack());
  await harness.settle();

  assert.equal(harness.sent('open').length, 1);
  finishDecoderVerification([]);
  await start;
});

test('accepted rendered PCM credits each captured session before queued promotion and excludes stale wire messages', async () => {
  const boundaries=[];
  const harness=createEngineHarness({measuredListening:true,handleStreamingPlaybackBoundary:event=>boundaries.push(event)});
  const outgoingTrack=makeTrack(), incomingTrack=makeTrack('next.flac');
  harness.context.state.player.current=outgoingTrack;
  harness.context.startListenSession(outgoingTrack);
  const outgoing=harness.context.state.player.listenSession;
  await harness.api.start(outgoingTrack);
  harness.contexts[0].sampleRate=48000;
  const current=harness.sent('open')[0];
  harness.nodes[0].port.dispatch({type:'first-frame',generation:current.generation,streamId:current.streamId,renderedFrame:0,contextTime:1});
  const consumed={type:'consumed',generation:current.generation,streamId:current.streamId,role:'current',frames:48000,bufferedFrames:0,audible:false};
  harness.nodes[0].port.dispatch(consumed);
  harness.nodes[0].port.dispatch({...consumed,generation:current.generation-1});
  harness.nodes[0].port.dispatch({...consumed,role:'continuity'});
  harness.nodes[0].port.dispatch({...consumed,streamId:999});
  assert.equal(outgoing.measurement.total,1);
  harness.nodes[0].port.dispatch({...consumed,type:'underrun'});
  assert.equal(outgoing.measurement.contiguous,0);
  harness.sockets[0].receive({type:'eos',generation:current.generation,streamId:current.streamId,role:'current',emittedFrames:144000,authoritativeTotalFrames:144000});
  await harness.api.continuity(incomingTrack);
  const incoming=harness.sent('open')[1];
  harness.nodes[0].port.dispatch({...consumed,streamId:incoming.streamId,role:'continuity',frames:24000});
  assert.equal(outgoing.measurement.total,1);
  harness.nodes[0].port.dispatch({type:'boundary',generation:current.generation,outgoingStreamId:current.streamId,incomingStreamId:incoming.streamId,renderedFrame:48000,timelineFrame:24000,capture:{}});
  assert.equal(boundaries[0].incomingListenSession.measurement.total,.5);
  assert.equal(boundaries[0].incomingListenSession.track.path,incomingTrack.path);
  harness.nodes[0].port.dispatch({...consumed,streamId:incoming.streamId,role:'continuity'});
  assert.equal(boundaries[0].incomingListenSession.measurement.total,1.5);
  assert.equal(outgoing.measurement.total,1);
});

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
    startNextTrackPath: '',
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
    startNextTrackPath: '',
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

test('interruption reconciliation resumes the same buffered stream', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const context = harness.contexts[0];
  const generation = harness.engine.generation;
  const streamId = harness.engine.roles.current.streamId;
  const socket = harness.engine.socket;
  const playMessagesBefore = harness.portMessages('play').length;

  context.state = 'suspended';
  assert.equal(await harness.api.reconcileInterruption(context), 'resumed');

  assert.equal(context.state, 'running');
  assert.equal(harness.engine.generation, generation);
  assert.equal(harness.engine.roles.current.streamId, streamId);
  assert.strictEqual(harness.engine.socket, socket);
  assert.equal(harness.engine.snapshot.paused, false);
  assert.equal(
    harness.portMessages('play').length,
    playMessagesBefore,
    'resuming an externally suspended context must not restart the worklet timeline',
  );
});

test('concurrent foreground signals share one interruption recovery attempt', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const context = harness.contexts[0];
  let releaseResume;
  context.state = 'suspended';
  context.resumeCalls = 0;
  context.resume = async function blockedResume() {
    this.resumeCalls += 1;
    await new Promise((resolve) => {
      releaseResume = resolve;
    });
    this.state = 'running';
  };

  const first = harness.api.reconcileInterruption(context);
  const second = harness.api.reconcileInterruption(context);
  await harness.settle();

  assert.equal(context.resumeCalls, 1);
  releaseResume();
  assert.deepEqual(await Promise.all([first, second]), ['resumed', 'resumed']);
  assert.equal(harness.engine.snapshot.paused, false);
});

test('blocked interruption recovery becomes truthfully paused and remains user resumable', async () => {
  const harness = createEngineHarness({ resumeLeavesSuspended: true });
  await harness.api.start(makeTrack(), { allowSuspendedAutoplayFallback: true });
  const context = harness.contexts[0];
  context.state = 'running';
  harness.engine.snapshot.paused = false;
  harness.engine.mode = 'playing';

  context.state = 'suspended';
  const result = await harness.api.reconcileInterruption(context);

  assert.equal(result, 'gesture-required');
  assert.equal(harness.engine.snapshot.paused, true);
  assert.equal(harness.engine.mode, 'paused');
  assert.equal(harness.portMessages('pause').length, 1);

  harness.contexts[0].state = 'suspended';
  harness.contexts[0].resume = async function resumeAfterGesture() {
    this.resumeCalls += 1;
    this.state = 'running';
  };
  assert.equal(await harness.api.resume(), true);
  assert.equal(harness.engine.snapshot.paused, false);
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
  assert.equal(harness.api.snapshot().mode, 'starting');
});

test('resume restores playing mode when current already rendered its first frame', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  await harness.api.pause();

  await harness.api.resume();

  assert.equal(harness.api.snapshot().paused, false);
  assert.equal(harness.api.snapshot().mode, 'playing');
});

test('pause invalidates a pending AudioContext resume before it can command audible playback', async () => {
  let finishResume;
  let delayResume = false;
  const harness = createEngineHarness({
    resumeContext: () => delayResume ? new Promise((resolve) => { finishResume = resolve; }) : undefined,
  });
  await harness.api.start(makeTrack());
  await harness.api.pause();
  const playsBefore = harness.portMessages('play').length;
  delayResume = true;
  const resume = harness.api.resume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishResume, 'function');
  await harness.api.pause();
  assert.equal(harness.api.snapshot().paused, true);
  finishResume();
  await resume;
  assert.equal(harness.portMessages('play').length, playsBefore,
    'a late AudioContext resume cannot send a play command after Pause');
  assert.equal(harness.api.snapshot().paused, true);
  assert.equal(harness.nodes[0].port.messages.at(-1).message.type, 'pause');
});

test('late pause completion cannot overwrite the mode of a newer explicit resume', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  let finishSuspend;
  harness.contexts[0].suspend = () => {
    harness.contexts[0].state = 'suspended';
    return new Promise((resolve) => { finishSuspend = resolve; });
  };
  const pause = harness.api.pause();
  assert.equal(harness.api.snapshot().paused, true);
  await harness.api.resume();
  assert.equal(harness.api.snapshot().paused, false);
  const resumedMode = harness.engine.mode;
  finishSuspend();
  await pause;
  assert.equal(harness.engine.mode, resumedMode);
  assert.equal(harness.api.snapshot().paused, false);
  assert.equal(harness.nodes[0].port.messages.at(-1).message.type, 'play');
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
    samples: new Array(12_000 * 2).fill(0.25),
  }, { role: 'current' });
  assert.equal(harness.api.snapshot().diagnostics.staleMessages, staleBeforePromotedWirePcm);
  assert.equal(harness.portMessages('enqueue').at(-1).role, 'current');
  harness.sockets[0].receive({
    type: 'eos',
    generation: target.generation,
    streamId: target.streamId,
    role: 'continuity',
    emittedFrames: 24_000,
    authoritativeTotalFrames: 168_000,
  });
  assert.equal(
    harness.api.snapshot().duration,
    240,
    'a prepared seek tail must not redefine the established whole-track duration',
  );
  assert.equal(harness.api.snapshot().mode, 'playing');
  assert.equal(harness.portMessages('eos').at(-1).role, 'current');
  const openCountBeforePromotionAck = harness.sent('open').length;
  harness.sockets[0].receive({
    type: 'promoted', generation: current.generation, streamId: target.streamId, role: 'current',
  });
  await harness.settle();
  assert.equal(
    harness.sent('open').length,
    openCountBeforePromotionAck,
    'queued-next must wait until the promoted seek target renders its first frame',
  );

  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: target.streamId,
    renderedFrame: 128, contextTime: 2,
  });
  await harness.settle();
  const restoredQueued = harness.sent('open').at(-1);
  assert.equal(restoredQueued.path, 'C:/Music/Album/queued.flac');
  assert.equal(restoredQueued.role, 'continuity');
  assert.deepEqual([...harness.api.snapshot().diagnostics.activeRoles], ['current', 'continuity']);

  const restoredCreditCount = harness.sent('credit')
    .filter(({ streamId }) => streamId === restoredQueued.streamId).length;
  acceptMetadata(harness, restoredQueued);
  const restoredCredits = harness.sent('credit')
    .filter(({ streamId }) => streamId === restoredQueued.streamId);
  assert.equal(
    restoredCredits.length,
    restoredCreditCount + 1,
    'an EOS seek tail shorter than one second must not defer queued-next initial credit',
  );
  assert.ok(restoredCredits.at(-1).frames > 0);
  assert.equal(harness.engine.roles.continuity.initialCreditDeferred, false);
});

test('forward seek within current ring preserves prepared queued-next PCM', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 192_000;
  harness.engine.diagnostics.inFlightFrames.current = 0;
  await harness.api.continuity(makeTrack('queued.flac'));
  const queued = harness.sent('open').at(-1);
  harness.engine.diagnostics.bufferedFrames.continuity = 48_000;
  const openCount = harness.sent('open').length;
  const currentCreditCount = harness.sent('credit')
    .filter(({ streamId }) => streamId === current.streamId).length;

  const seek = harness.api.seek(3);
  const reservation = harness.portMessages('reserve-buffered-seek').at(-1);
  assert.deepEqual({ ...reservation }, {
    type: 'reserve-buffered-seek',
    generation: current.generation,
    requestId: 1,
    streamId: current.streamId,
    timelineFrame: 144_000,
  });
  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-reserved',
    generation: current.generation,
    requestId: 1,
    streamId: current.streamId,
    timelineFrame: 144_000,
  });
  const firstFrameBeforeSeek = harness.engine.diagnostics.firstFrameAtMs;
  harness.setNow(1001);
  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-boundary',
    generation: current.generation,
    requestId: 1,
    streamId: current.streamId,
    renderedFrame: 128,
    timelineFrame: 144_000,
    skippedFrames: 120_000,
    bufferedFrames: 72_000,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });
  assert.equal(await seek, harness.engine.roles.current);

  assert.equal(harness.sent('open').length, openCount);
  assert.equal(harness.sent('close').length, 0);
  assert.equal(harness.sent('promote').length, 0);
  assert.equal(harness.engine.roles.current.streamId, current.streamId);
  assert.equal(harness.engine.roles.continuity.streamId, queued.streamId);
  assert.equal(harness.engine.diagnostics.bufferedFrames.current, 72_000);
  const currentCredits = harness.sent('credit')
    .filter(({ streamId }) => streamId === current.streamId);
  assert.equal(currentCredits.length, currentCreditCount + 1);
  assert.ok(currentCredits.at(-1).frames > 0);
  assert.equal(harness.api.snapshot().currentTime, 3);
  assert.equal(harness.api.snapshot().diagnostics.seekSilentFrames, 0);
  assert.ok(harness.api.snapshot().diagnostics.firstFrameAtMs > firstFrameBeforeSeek);
  assert.ok(
    harness.api.snapshot().diagnostics.firstFrameAtMs
      >= harness.api.snapshot().diagnostics.seekCommittedAtMs,
  );
  assert.deepEqual(harness.api.snapshot().diagnostics.seekCapture, {
    outgoing: { frames: 64 }, incoming: { frames: 1 },
  });
});

test('forward seek beyond unread current PCM uses continuity replacement', async () => {
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
  harness.engine.diagnostics.bufferedFrames.continuity = 48_000;

  const replacement = await harness.api.seek(3);

  assert.equal(harness.portMessages('reserve-buffered-seek').length, 0);
  assert.equal(replacement.continuityOptions.kind, 'seek');
  assert.equal(harness.sent('close').at(-1).reason, 'seek-replaced');
  assert.equal(harness.sent('open').at(-1).path, current.path);
});

test('new fallback seek supersedes a pending buffered forward seek once', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 192_000;
  await harness.api.continuity(makeTrack('queued.flac'));
  harness.engine.snapshot.currentTime = 2;
  harness.engine.diagnostics.bufferedFrames.continuity = 48_000;
  assert.equal(harness.engine.roles.continuity.continuityOptions.kind, 'queued-next');
  assert.equal(harness.engine.snapshot.paused, false);

  const bufferedSeek = harness.api.seek(3);
  assert.ok(harness.engine.pendingBufferedSeek);
  const fallbackSeek = harness.api.seek(1);

  assert.equal(harness.engine.pendingBufferedSeek, null);
  assert.equal(await bufferedSeek, null);
  const replacement = await fallbackSeek;
  assert.equal(replacement.continuityOptions.kind, 'seek');
  assert.equal(harness.sent('open').filter(({ path }) => path === current.path).length, 2);
});

test('pause supersedes a pending buffered forward seek without starting fallback', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 192_000;
  await harness.api.continuity(makeTrack('queued.flac'));
  harness.engine.diagnostics.bufferedFrames.continuity = 48_000;
  const openCount = harness.sent('open').length;

  const seek = harness.api.seek(3);
  assert.ok(harness.engine.pendingBufferedSeek);
  await harness.api.pause();

  assert.equal(await seek, null);
  assert.equal(harness.engine.pendingBufferedSeek, null);
  assert.equal(harness.api.snapshot().paused, true);
  assert.equal(harness.sent('open').length, openCount);
});

test('late buffered boundary after pause still reconciles skipped PCM accounting', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 192_000;
  harness.engine.diagnostics.inFlightFrames.current = 0;
  await harness.api.continuity(makeTrack('queued.flac'));
  harness.engine.diagnostics.bufferedFrames.continuity = 48_000;

  const seek = harness.api.seek(3);
  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-reserved', generation: current.generation,
    requestId: 1, streamId: current.streamId, timelineFrame: 144_000,
  });
  const staleMessages = harness.engine.diagnostics.staleMessages;
  await harness.api.pause();
  assert.equal(await seek, null);

  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-boundary', generation: current.generation,
    requestId: 1, streamId: current.streamId, timelineFrame: 144_000,
    renderedFrame: 128, skippedFrames: 120_000, bufferedFrames: 72_000,
    silentFrames: 0, capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });

  assert.equal(harness.engine.diagnostics.staleMessages, staleMessages);
  assert.equal(harness.engine.diagnostics.bufferedFrames.current, 72_000);
  assert.equal(harness.api.snapshot().currentTime, 3);
  assert.ok(harness.engine.deferredCreditFrames.current > 0);
});

test('late superseded buffered boundary reconciles accounting without completing newer seek', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 192_000;
  await harness.api.continuity(makeTrack('queued.flac'));
  harness.engine.diagnostics.bufferedFrames.continuity = 48_000;

  const firstSeek = harness.api.seek(3);
  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-reserved', generation: current.generation,
    requestId: 1, streamId: current.streamId, timelineFrame: 144_000,
  });
  const secondSeek = harness.api.seek(3.5);
  assert.equal(await firstSeek, null);
  assert.equal(harness.engine.pendingBufferedSeek, null);
  assert.equal(harness.engine.supersededBufferedSeek.requestId, 1);
  const staleMessages = harness.engine.diagnostics.staleMessages;

  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-boundary', generation: current.generation,
    requestId: 1, streamId: current.streamId, timelineFrame: 144_000,
    renderedFrame: 128, skippedFrames: 120_000, bufferedFrames: 72_000,
    silentFrames: 0, capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });

  assert.equal(harness.engine.diagnostics.staleMessages, staleMessages);
  assert.equal(harness.engine.diagnostics.bufferedFrames.current, 72_000);
  assert.equal(harness.engine.pendingBufferedSeek, null);
  assert.equal(harness.engine.supersededBufferedSeek, null);
  assert.equal(harness.engine.diagnostics.seekCommittedAtMs, 0);
  const replacement = await secondSeek;
  assert.equal(replacement.continuityOptions.kind, 'seek');
  assert.equal(replacement.generation, current.generation);
  assert.equal(replacement.track.path, current.path);
  await harness.api.pause();
});

test('prepared track replacement retains late buffered boundary accounting', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 192_000;
  harness.engine.diagnostics.inFlightFrames.current = 0;
  await harness.api.continuity(makeTrack('queued.flac'));
  harness.engine.diagnostics.bufferedFrames.continuity = 48_000;

  const seek = harness.api.seek(3);
  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-reserved', generation: current.generation,
    requestId: 1, streamId: current.streamId, timelineFrame: 144_000,
  });
  const replacementStart = harness.api.start(makeTrack('replacement.flac'));
  assert.equal(await seek, null);
  const staleMessages = harness.engine.diagnostics.staleMessages;

  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-boundary', generation: current.generation,
    requestId: 1, streamId: current.streamId, timelineFrame: 144_000,
    renderedFrame: 128, skippedFrames: 120_000, bufferedFrames: 72_000,
    silentFrames: 0, capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });

  assert.equal(harness.engine.diagnostics.staleMessages, staleMessages);
  assert.equal(harness.engine.diagnostics.bufferedFrames.current, 72_000);
  assert.equal(harness.api.snapshot().currentTime, 3);
  assert.equal(harness.engine.supersededBufferedSeek, null);
  await harness.api.pause();
  await replacementStart;
});

test('late buffered boundary clears its retained identity after current role changes', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 192_000;
  await harness.api.continuity(makeTrack('queued.flac'));
  harness.engine.diagnostics.bufferedFrames.continuity = 48_000;

  const seek = harness.api.seek(3);
  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-reserved', generation: current.generation,
    requestId: 1, streamId: current.streamId, timelineFrame: 144_000,
  });
  await harness.api.pause();
  assert.equal(await seek, null);
  harness.engine.roles.current = harness.engine.roles.continuity;
  harness.engine.roles.continuity = null;
  const staleMessages = harness.engine.diagnostics.staleMessages;

  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-boundary', generation: current.generation,
    requestId: 1, streamId: current.streamId, timelineFrame: 144_000,
    renderedFrame: 128, skippedFrames: 120_000, bufferedFrames: 72_000,
    silentFrames: 0, capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });

  assert.equal(harness.engine.diagnostics.staleMessages, staleMessages + 1);
  assert.equal(harness.engine.diagnostics.bufferedFrames.current, 192_000);
  assert.equal(harness.engine.supersededBufferedSeek, null);
});

test('rejected buffered forward seek falls back to continuity replacement', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack('current.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 192_000;
  await harness.api.continuity(makeTrack('queued.flac'));
  const queued = harness.sent('open').at(-1);
  harness.engine.diagnostics.bufferedFrames.continuity = 48_000;

  const seek = harness.api.seek(3);
  harness.nodes[0].port.dispatch({
    type: 'buffered-seek-rejected',
    generation: current.generation,
    requestId: 1,
    streamId: current.streamId,
    timelineFrame: 144_000,
    reason: 'unavailable',
  });
  const replacement = await seek;

  assert.equal(replacement.role, 'continuity');
  assert.equal(replacement.startFrame, 144_000);
  assert.equal(harness.sent('close').at(-1).streamId, queued.streamId);
  assert.equal(harness.sent('close').at(-1).reason, 'seek-replaced');
  assert.equal(harness.sent('open').at(-1).streamId, replacement.streamId);
  assert.equal(harness.portMessages('reserve-seek').at(-1).streamId, replacement.streamId);
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
    startupBufferFrames: 2 * 48_000,
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

test('production ring limits give every track the same cushion after a boundary swap', () => {
  const coreState = fs.readFileSync(
    path.join(repoRoot, 'music_app/static/js/runtime/core-state-and-helpers.js'),
    'utf8',
  );
  const [, currentSeconds, continuitySeconds] = coreState.match(
    /limits: \{ currentSeconds: (\d+), continuitySeconds: (\d+) \}/,
  );
  assert.equal(
    continuitySeconds,
    currentSeconds,
    'rings swap at every promotion, so a smaller continuity ring starves every second track',
  );
});

test('a promoted track keeps the full protected cushion with equal production rings', async () => {
  const harness = createEngineHarness();
  harness.engine.limits = { currentSeconds: 12, continuitySeconds: 12 };
  await harness.api.start(makeTrack('01.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.flac'));
  const continuity = harness.sent('open').at(-1);
  acceptMetadata(harness, continuity);

  harness.nodes[0].port.dispatch({
    type: 'boundary',
    generation: current.generation,
    outgoingStreamId: current.streamId,
    incomingStreamId: continuity.streamId,
    renderedFrame: 1,
    timelineFrame: 1,
    capture: { outgoing: { frames: 1 }, incoming: { frames: 1 } },
  });

  assert.equal(harness.engine.roles.current.streamId, continuity.streamId);
  assert.equal(harness.engine.roles.current.targetBufferFrames, 12 * 48_000);
});

test('a finished rebuffer reports its measured stall over the playback socket', async () => {
  const harness = createEngineHarness();
  harness.setNow(1_000);
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  const identity = {
    generation: current.generation, streamId: current.streamId, role: 'current', timelineFrame: 0,
  };

  harness.nodes[0].port.dispatch({ type: 'buffering-start', ...identity });
  harness.setNow(4_600);
  harness.nodes[0].port.dispatch({ type: 'buffering-end', ...identity });

  assert.deepEqual({ ...harness.sent('stall-report').at(-1) }, {
    type: 'stall-report',
    generation: current.generation,
    streamId: current.streamId,
    durationMs: 3_600,
    targetBufferFrames: 11 * 48_000,
    pageVisible: true,
  });
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
    startupBufferFrames: 2 * 48_000,
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

  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: seekTarget.generation, streamId: seekTarget.streamId,
    renderedFrame: 128, contextTime: 12.5,
  });
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
      primed: true,
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
  // The promoted current has a second buffered, so the next switch crosses over from it.
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: firstReplacement.generation,
    streamId: firstReplacement.streamId,
    sequence: 1,
    samples: new Array(36_000 * 2).fill(0.5),
  }, { role: 'current' });
  const secondStarting = harness.api.start(secondReplacementTrack);
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
  assert.deepEqual(harness.portMessages('expect-continuity').map((message) => ({
    generation: message.generation,
    active: message.active,
  })), [{
    generation: current.generation,
    active: true,
  }]);
});

test('a queued successor tells the worklet whether it is the next track of the same album', async () => {
  const harness = createEngineHarness();
  const currentTrack = makeTrack('album-01.flac');
  const queuedTrack = makeTrack('album-02.flac');
  await harness.api.start(currentTrack);
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation,
    streamId: current.streamId,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 12.5,
  });

  await harness.api.continuity(queuedTrack, { kind: 'queued-next', consecutiveAlbumBoundary: true });
  const prepared = harness.engine.roles.continuity;
  await harness.api.continuity(queuedTrack, { kind: 'queued-next', consecutiveAlbumBoundary: false });

  assert.equal(harness.sent('open').length, 2, 'a changed qualification keeps the prepared decoder');
  assert.strictEqual(harness.engine.roles.continuity, prepared);
  assert.equal(prepared.continuityOptions.consecutiveAlbumBoundary, false);
  assert.deepEqual(harness.portMessages('expect-continuity').map(({ active, consecutiveAlbumBoundary }) => ({
    active, consecutiveAlbumBoundary,
  })), [
    { active: true, consecutiveAlbumBoundary: true },
    { active: true, consecutiveAlbumBoundary: false },
  ]);
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

test('retains inspectable processor failures in engine diagnostics', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  harness.nodes[0].fail(new Error('render crashed'));
  const snapshot = harness.api.snapshot();
  assert.equal(snapshot.mode, 'error');
  assert.equal(snapshot.diagnostics.lastError.source, 'processor');
  assert.match(snapshot.diagnostics.lastError.message, /render crashed/);
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
  assert.deepEqual({ ...harness.portMessages('expect-continuity').at(-1) }, {
    type: 'expect-continuity',
    generation: firstContinuity.generation,
    active: false,
  }, 'cancelling a queued successor clears its matching-generation EOF expectation');
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

for (const pauseAt of ['before-prepare', 'before-boundary', 'queued-boundary']) {
  test(`pause cancels replacement at ${pauseAt} without changing resumed audible track`, async (t) => {
    const harness = createEngineHarness({ realProcessor: true });
    t.after(() => harness.api.stop());
    const track = makeTrack('outgoing.flac');
    await harness.api.start(track);
    const outgoing = harness.sent('open')[0];
    acceptMetadata(harness, outgoing);
    receivePcmAndAssertEnqueue(harness, {
      generation: outgoing.generation, streamId: outgoing.streamId,
      samples: new Array(48_000 * 2).fill(0.25),
    });
    const node = harness.nodes[0];
    node.render();
    node.deliverEvents();
    receivePcmAndAssertEnqueue(harness, {
      generation: outgoing.generation, streamId: outgoing.streamId, sequence: 1,
      samples: new Array(48_000 * 2).fill(0.25),
    });
    node.render();
    node.deliverEvents();
    const starting = harness.api.start(makeTrack('replacement.flac')).catch(() => null);
    const replacement = harness.sent('open').at(-1);
    assert.notEqual(replacement.streamId, outgoing.streamId);
    if (pauseAt !== 'before-prepare') {
      acceptMetadata(harness, replacement);
      receivePcmAndAssertEnqueue(harness, {
        role: 1, generation: replacement.generation, streamId: replacement.streamId,
        samples: new Array(48_000 * 2).fill(0.75),
      });
      receivePcmAndAssertEnqueue(harness, {
        role: 1, generation: replacement.generation, streamId: replacement.streamId, sequence: 1,
        samples: new Array(48_000 * 2).fill(0.75),
      });
      node.deliverEvents();
      assert.equal(harness.engine.pendingSeek.prepareSent, true);
    }
    if (pauseAt === 'queued-boundary') {
      assert.ok(node.render()[0].every((sample) => sample === 0.75));
      assert.ok(node.port.events.some((event) => event.type === 'seek-boundary'));
    }
    const retainedTime = harness.api.snapshot().currentTime;
    await harness.api.pause();
    assert.equal(harness.engine.pendingSeek, null,
      'pause must cancel a pending replacement before its delayed cutover');
    node.render();
    node.deliverEvents();
    const restored = harness.sent('open').at(-1);
    if (restored.streamId !== replacement.streamId) {
      assert.equal(restored.startFrame, Math.round(retainedTime * 48_000));
      acceptMetadata(harness, restored);
    }
    await harness.api.resume();
    if (restored.streamId !== replacement.streamId) {
      receivePcmAndAssertEnqueue(harness, {
        generation: restored.generation, streamId: restored.streamId,
        samples: new Array(48_000 * 2).fill(0.25),
      });
      receivePcmAndAssertEnqueue(harness, {
        generation: restored.generation, streamId: restored.streamId, sequence: 1,
        samples: new Array(48_000 * 2).fill(0.25),
      });
    }
    const output = node.render();
    node.deliverEvents();
    assert.equal(harness.engine.roles.current?.track.path, track.path,
      'cancelled replacement must not become the engine current track');
    assert.ok(output[0].every((sample) => sample === 0.25),
      'resume must render outgoing PCM, never cancelled replacement PCM or silence');
    await starting;
  });
}

function loadLeaseRecoveryRuntime(harness) {
  const { context } = harness;
  Object.assign(context, {
    AbortController,
    getPlayerPlaybackSnapshot: harness.api.snapshot,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async (url) => ({ ok: true, json: async () => url === '/playback/refs'
      ? { protocol: 1, expiresAt: '2099-10-24T00:00:00Z', tracks: [{ playbackRef: 'ref-1' }] }
      : { ok: true, protocol: 1, claimToken: 'fresh-claim', expiresAt: new Date(context.Date.now() + 30_000).toISOString(), leaseMs: 30_000,
        is_playing_elsewhere: false, is_playing_here: false } }),
  });
  for (const filename of ['playback-ownership-helpers.js', 'player-loop-playback.js']) {
    vm.runInContext(fs.readFileSync(path.join(path.dirname(enginePath), filename), 'utf8'), context);
  }
  context.updatePlayerUi = () => {};
  context.state.player.ownership = { tabId: 'lease-client', requestVersion: 0, activeClaim: null };
}

for (const interruptionMs of [1_000, 3_600_001]) {
  test(`lease interruption of ${interruptionMs}ms resets contiguous listening while preserving session identity`, async () => {
    const harness = createEngineHarness({ measuredListening: true });
    loadLeaseRecoveryRuntime(harness);
    const { context } = harness;
    const track = makeTrack('interrupted-listen.flac');
    context.state.player.current = track;
    const requests = [];
    const fetch = context.fetch;
    context.fetch = (url, options) => { requests.push(url); return fetch(url, options); };
    let now = harness.dateNow();
    context.Date.now = () => now;
    context.isoNow = () => new Date(now).toISOString();
    context.unixNowSeconds = () => Math.floor(now / 1000);
    const consumeTwentySeconds = () => {
      const role = harness.engine.roles.current;
      harness.nodes.at(-1).port.dispatch({ type: 'consumed', generation: role.generation,
        streamId: role.streamId, role: 'current', frames: 20 * 48_000, bufferedFrames: 0, audible: true });
    };
    try {
      assert.equal(await context.claimPlaybackOwnership(track), true);
      await context.resumeListenSessionPlayback(track, 0);
      await harness.api.start(track);
      const original = context.state.player.listenSession;
      consumeTwentySeconds();
      assert.equal(original.measurement.total, 20);
      assert.equal(original.measurement.longest, 20);
      const requestsBeforeLoss = requests.length;
      context.losePlaybackOwnership();
      await harness.settle();
      assert.equal(requests.length, requestsBeforeLoss,
        'lease-loss bookkeeping must not send unauthorized listen effects');
      now += interruptionMs;
      await context.handlePlaybackOwnershipEvent();
      context.togglePlayerPlayback({ focusTimelineOnResume: false });
      await harness.settle();
      await harness.settle();
      consumeTwentySeconds();
      const resumed = context.state.player.listenSession;
      assert.strictEqual(resumed, original, 'time-only interruption must not create another provider identity');
      assert.equal(resumed.measurement.total, 40, 'interrupted silence adds no measured time');
      assert.equal(resumed.measurement.longest, 20,
        'separate audible intervals must not merge across ownership loss');
    } finally {
      clearTimeout(context.getPlaybackOwnershipState().expiryTimer);
      await harness.api.stop();
    }
  });
}

test('lease recovery reinstalls the active loop before first-frame queued-next scheduling', async () => {
  const harness = createEngineHarness();
  loadLeaseRecoveryRuntime(harness);
  const { context } = harness;
  const track = makeTrack('looping.flac');
  const next = makeTrack('queued-next.flac');
  Object.assign(context.state.player, { current: track, loopActive: true, loopStart: 20, loopEnd: 40 });
  const firstFrame = () => {
    const role = harness.engine.roles.current;
    harness.nodes.at(-1).port.dispatch({ type: 'first-frame', generation: role.generation,
      streamId: role.streamId, renderedFrame: 0, contextTime: 1 });
  };
  try {
    assert.equal(await context.claimPlaybackOwnership(track), true);
    await harness.api.start(track, { startSeconds: 25 });
    firstFrame();
    await context.scheduleActiveStreamingLoop();
    assert.equal(harness.engine.loopContinuity?.kind, 'long-loop');
    context.peekNextQueuedTrack = () => next;
    context.losePlaybackOwnership();
    await harness.settle();
    const opensBeforeRecovery = harness.sent('open').length;
    await context.handlePlaybackOwnershipEvent();
    context.togglePlayerPlayback({ focusTimelineOnResume: false });
    await harness.settle();
    firstFrame();
    await harness.settle();
    assert.equal(context.state.player.loopActive, true);
    assert.equal(harness.engine.loopContinuity?.kind, 'long-loop',
      'the still-active loop must be installed in the restarted engine');
    assert.equal(harness.engine.loopContinuity.startSeconds, 20);
    assert.equal(harness.engine.loopContinuity.endSeconds, 40);
    assert.equal(harness.engine.roles.continuity?.track.path, track.path);
    assert.equal(harness.sent('open').slice(opensBeforeRecovery).some(open => open.path === next.path), false,
      'first-frame recovery must not open the queued next track while looping');
  } finally {
    clearTimeout(context.getPlaybackOwnershipState().expiryTimer);
    await harness.api.stop();
  }
});

test('explicit Play after lease loss reopens the real current stream at its retained audible offset', async () => {
  const harness = createEngineHarness({ realProcessor: true });
  loadLeaseRecoveryRuntime(harness);
  const { context } = harness;
  const track = makeTrack('lease-recovery.flac');
  context.state.player.current = track;
  try {
    assert.equal(await context.claimPlaybackOwnership(track), true);
    await harness.api.start(track, { startSeconds: 12 });
    const initial = harness.sent('open')[0];
    acceptMetadata(harness, initial);
    receivePcmAndAssertEnqueue(harness, { generation: initial.generation, streamId: initial.streamId,
      samples: new Array(48_000 * 2).fill(0.25) });
    receivePcmAndAssertEnqueue(harness, { generation: initial.generation, streamId: initial.streamId,
      sequence: 1, samples: new Array(48_000 * 2).fill(0.25) });
    assert.ok(harness.nodes[0].render()[0].every(sample => sample === 0.25));
    harness.nodes[0].deliverEvents();
    const retainedSeconds = harness.api.snapshot().currentTime;
    assert.ok(retainedSeconds >= 12);
    context.losePlaybackOwnership();
    await harness.settle();
    assert.equal(harness.api.snapshot().paused, true);
    assert.equal(harness.engine.roles.current, null);
    await context.handlePlaybackOwnershipEvent();
    assert.equal(context.togglePlayerPlayback({ focusTimelineOnResume: false }), true);
    await harness.settle();
    assert.equal(context.isActivePlaybackOwner(), true);
    assert.equal(harness.engine.roles.current?.track.path, track.path,
      'explicit Play must recreate a real current decoder, not resume an empty engine');
    const reopened = harness.sent('open').at(-1);
    assert.equal(reopened.startFrame, Math.round(retainedSeconds * 48_000));
    const socket = harness.sockets.at(-1);
    socket.receive({ type: 'metadata', generation: reopened.generation, streamId: reopened.streamId,
      role: 'current', sampleRate: 48_000, channels: 2, provisionalTotalFrames: 11_520_000,
      requestedStartFrame: reopened.startFrame, timelineStartFrame: reopened.startFrame });
    receivePcmAndAssertEnqueue(harness, { generation: reopened.generation, streamId: reopened.streamId,
      samples: new Array(48_000 * 2).fill(0.75) }, { socket });
    receivePcmAndAssertEnqueue(harness, { generation: reopened.generation, streamId: reopened.streamId,
      sequence: 1, samples: new Array(48_000 * 2).fill(0.75) }, { socket });
    assert.ok(harness.nodes.at(-1).render()[0].every(sample => sample === 0.75),
      'the recovered current stream must render actual non-silent PCM');
    harness.nodes.at(-1).deliverEvents();
    assert.ok(harness.api.snapshot().currentTime >= retainedSeconds);
  } finally {
    clearTimeout(context.getPlaybackOwnershipState().expiryTimer);
    await harness.api.stop();
  }
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

test('a switch from an outgoing song with under a second buffered crosses over without waiting for a cushion', async () => {
  const timers = [];
  const harness = createEngineHarness({
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
  });
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

  const starting = harness.api.start(makeTrack('replacement.flac'));
  await harness.settle();

  assert.equal(timers.filter(({ delay }) => delay === 1000).length, 0, 'nothing waits for the outgoing cushion');
  const fresh = harness.sent('open').at(-1);
  assert.equal(fresh.role, 'continuity', 'the outgoing song plays until the new one sounds');
  assert.equal(fresh.path, makeTrack('replacement.flac').path);
  assert.equal(fresh.generation, outgoing.generation);
  assert.equal(harness.portMessages('configure').length, 1, 'nothing clears the outgoing audio');
  acceptMetadata(harness, fresh);
  assert.ok(harness.sent('credit').some(({ streamId }) => streamId === fresh.streamId),
    'the new song is credited however little of the outgoing one is left');
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: fresh.generation,
    streamId: fresh.streamId,
    samples: new Array(12_000 * 2).fill(0.5),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: fresh.generation,
    outgoingStreamId: outgoing.streamId,
    incomingStreamId: fresh.streamId,
    renderedFrame: 128,
    timelineFrame: 0,
  });
  assert.equal((await starting).streamId, fresh.streamId);
});

test('replacement remains live when outgoing ended races worklet seek reservation', async () => {
  const ended = [];
  const harness = createEngineHarness({
    handleStreamingPlaybackEnded: (event) => ended.push(structuredClone(event)),
  });
  await harness.api.start(makeTrack('outgoing.flac'));
  const outgoing = harness.sent('open')[0];
  acceptMetadata(harness, outgoing);
  receivePcmAndAssertEnqueue(harness, {
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });

  const starting = harness.api.start(makeTrack('replacement.flac'));
  const replacement = harness.sent('open').at(-1);
  const playCount = harness.portMessages('play').length;
  assert.equal(harness.engine.pendingSeek.kind, 'replacement');

  harness.nodes[0].port.dispatch({
    type: 'ended',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    timelineFrame: 48_000,
  });

  assert.equal(harness.api.snapshot().ended, false);
  assert.equal(harness.api.snapshot().paused, false);
  assert.deepEqual(ended, []);
  assert.equal(harness.portMessages('play').length, playCount + 1);

  acceptMetadata(harness, replacement);
  receivePcmAndAssertEnqueue(harness, {
    role: 1,
    generation: replacement.generation,
    streamId: replacement.streamId,
    samples: new Array(48_000 * 2).fill(0.5),
  });
  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: replacement.generation,
    outgoingStreamId: outgoing.streamId,
    incomingStreamId: replacement.streamId,
    renderedFrame: 48_000,
    timelineFrame: 0,
    silentFrames: 0,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 1 } },
  });

  assert.equal((await starting).streamId, replacement.streamId);
});

test('paused replacement suppresses raced outgoing ended without restarting the worklet', async () => {
  const ended = [];
  const harness = createEngineHarness({
    handleStreamingPlaybackEnded: (event) => ended.push(structuredClone(event)),
  });
  await harness.api.start(makeTrack('outgoing.flac'));
  const outgoing = harness.sent('open')[0];
  acceptMetadata(harness, outgoing);
  receivePcmAndAssertEnqueue(harness, {
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    samples: new Array(48_000 * 2).fill(0.25),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });

  harness.api.start(makeTrack('replacement.flac'));
  await harness.api.pause();
  const playCount = harness.portMessages('play').length;
  harness.nodes[0].port.dispatch({
    type: 'ended',
    generation: outgoing.generation,
    streamId: outgoing.streamId,
    timelineFrame: 48_000,
  });

  assert.equal(harness.api.snapshot().ended, false);
  assert.equal(harness.api.snapshot().paused, true);
  assert.deepEqual(ended, []);
  assert.equal(harness.portMessages('play').length, playCount);
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

test('one buffering episode requests one coarse refill and preserves play intent', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  harness.engine.diagnostics.bufferedFrames.current = 0;
  harness.engine.diagnostics.inFlightFrames.current = 0;
  const creditCount = harness.sent('credit').length;
  const event = {
    type: 'buffering-start',
    generation: current.generation,
    streamId: current.streamId,
    role: 'current',
    timelineFrame: 12_000,
  };

  harness.nodes[0].port.dispatch(event);
  harness.nodes[0].port.dispatch(event);

  assert.equal(harness.sent('credit').length, creditCount + 1);
  assert.equal(harness.sent('credit').at(-1).frames, 48_000);
  assert.equal(harness.engine.mode, 'buffering');
  assert.equal(harness.engine.snapshot.paused, false);
  assert.equal(harness.engine.diagnostics.buffering, true);

  harness.nodes[0].port.dispatch({ ...event, type: 'buffering-end' });

  assert.equal(harness.engine.mode, 'playing');
  assert.equal(harness.engine.snapshot.paused, false);
  assert.equal(harness.engine.diagnostics.buffering, false);
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
  assert.equal(harness.api.snapshot().mode, 'playing');
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

// The head never resets to the start, and the song goes on when the network is back. A laptop serving
// the app through
// a tunnel that answers 530 for about a minute after its Wi-Fi returns: every attempt in that
// minute fails. A lost socket under audio that cannot play on waits at the heard place, still
// playing, and reopens there on the first socket the server answers, with nothing pressed.
test('a lost socket waits playing at the heard place and reopens there once the server answers, however many attempts fail first', async () => {
  let serverBack = false;
  const timers = manualTimers();
  const harness = createEngineHarness({
    refuseConnection: (count) => count > 1 && !serverBack,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const track = makeTrack();
  await harness.api.start(track);
  const first = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'position', generation: first.generation, streamId: first.streamId, timelineFrame: 3 * 48_000,
  });

  harness.sockets[0].unexpectedClose({ code: 1006, reason: 'network disappeared' });
  await settleTwice(harness);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    timers.fire(timers.pending().find(({ delay }) => delay <= 2_000));
    await settleTwice(harness);
  }
  const waiting = harness.api.snapshot();
  assert.notEqual(waiting.mode, 'error', 'failed attempts never end the wait');
  assert.equal(waiting.paused, false, 'the player stays on play');
  assert.equal(waiting.currentTime, 3, 'the head stays at the heard place, never the start');
  assert.equal(harness.contexts[0].closeCalls, 0);

  serverBack = true;
  timers.fire(timers.pending().find(({ delay }) => delay <= 2_000));
  await settleTwice(harness);
  const reopened = harness.sockets.at(-1).sent.find(({ type }) => type === 'open');
  assert.equal(reopened.path, track.path);
  assert.equal(reopened.startFrame, 3 * 48_000);
  assert.equal(harness.api.snapshot().paused, false);
});

// One press starts another song after an outage. Each press
// in the minute the tunnel answered 530 failed and needed another; one press now waits for the server.
test('another song pressed once while the server is still away opens on the first socket it answers', async () => {
  let serverBack = false;
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1 && !serverBack,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);

  let failure = null;
  const started = harness.api.start(makeTrack('02.mp3')).catch((error) => { failure = error; });
  await settleTwice(harness);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    timers.fire(timers.pending().find(({ delay }) => delay <= 2_000));
    await settleTwice(harness);
  }
  assert.equal(failure, null, 'the press is not refused while the server is away');
  assert.notEqual(harness.api.snapshot().mode, 'error');

  serverBack = true;
  timers.fire(timers.pending().find(({ delay }) => delay <= 2_000));
  await settleTwice(harness);
  await settleTwice(harness);
  const opened = harness.sockets.at(-1).sent.filter(({ type }) => type === 'open').at(-1);
  assert.equal(opened?.path, makeTrack('02.mp3').path, 'the one press opens the song');
  assert.equal(opened.startFrame, 0);
  void started;
});

test('a socket lost while another song waits to replace the playing one opens that song on the next socket, and the press completes', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  await startLocallySeekable(harness, 100_000);
  await harness.api.resume();
  await settleTwice(harness);

  let pressed;
  const press = harness.api.start(makeTrack('02.mp3')).then((role) => { pressed = role; });
  await settleTwice(harness);
  assert.equal(harness.engine.pendingSeek?.kind, 'replacement', 'the song is prepared beside the playing one');

  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  await settleTwice(harness);
  const opened = harness.sockets.at(-1).sent.filter(({ type }) => type === 'open').at(-1);
  assert.equal(opened?.path, makeTrack('02.mp3').path);
  assert.equal(opened.startFrame, 0);
  await press;
  assert.equal(pressed?.track.path, makeTrack('02.mp3').path, 'the press settles with the reopened song');
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

// Hosted FTC-PLAYBACK-OFFLINE-002: the socket died while a press on another song was still
// starting. The old song's splice, or a restart of the old song at its place, then took the press's place.
test('a socket lost while a press on another song is still starting opens only that song on the next socket', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  await startLocallySeekable(harness, 100_000);
  await harness.api.pause();
  await settleTwice(harness);

  let failure = null;
  const press = harness.api.start(makeTrack('02.mp3')).catch((error) => { failure = error; });
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  await settleTwice(harness);
  await settleTwice(harness);

  const opens = harness.sockets.slice(1).flatMap((socket) => socket.sent.filter(({ type }) => type === 'open'));
  assert.deepEqual(opens.map(({ path, startFrame }) => [path, startFrame]), [[makeTrack('02.mp3').path, 0]],
    'only the pressed song opens, from its start');
  assert.equal(failure, null);
  assert.equal(harness.engine.roles.current?.track.path, makeTrack('02.mp3').path);
  void press;
});

// Hosted FTC-PLAYBACK-OFFLINE-001/003: two restarts in one outage left a close queued for
// the first restart's stream, whose open never left the page. The server refused that close (4400)
// on the next socket and the player stopped with an error.
test('the next socket never gets a control for a stream that was not opened on it', async () => {
  let online = false;
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1 && !online,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  await harness.api.resume();
  harness.dispatchWindowEvent('offline');
  await settleTwice(harness);
  await harness.api.seek(200);
  await settleTwice(harness);
  const unsent = { type: 'close', generation: harness.engine.generation, streamId: harness.engine.nextStreamId + 7, reason: 'replacement' };
  harness.engine.pendingControls.unshift(unsent);

  online = true;
  timers.fire(timers.pending().find(({ delay }) => delay <= 2_000));
  await settleTwice(harness);
  const sent = harness.sockets.at(-1).sent;
  assert.deepEqual(sent.filter(({ type }) => type === 'close'), [], 'no close for a stream the server never opened');
  assert.deepEqual(sent.filter(({ type }) => type === 'open').map(({ startFrame }) => startFrame), [200 * 48_000]);
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

// A network that froze and came back gave no sign, and playback resumed 19.6 s
// later while an attempt with the doubled 16 s deadline hung. The server is asked every 1.5 s whether it
// answers; once it does, the hanging attempt is replaced at once with the short deadline.
test('after a frozen network, the hanging reconnect is replaced as soon as the server answers again', async () => {
  let frozen = true;
  const timers = manualTimers();
  const probes = [];
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => (count > 1 && frozen ? 'hang' : false),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async (url) => {
      probes.push(url);
      if (frozen) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await startLocallySeekable(harness, 100_000);
  await harness.api.resume();
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  // Three hung attempts double the next one's deadline to 16 s.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const deadline = timers.pending().find(({ delay }) => delay >= 4_000);
    timers.fire(deadline);
    await settleTwice(harness);
    const retry = timers.pending().find(({ delay }) => delay <= 2_000);
    if (retry) timers.fire(retry);
    await settleTwice(harness);
  }
  assert.ok(timers.pending().some(({ delay }) => delay === 16_000), 'the hanging attempt has the long deadline');
  const hanging = harness.sockets.length;

  const probe = () => harness.intervals.filter(({ delay }) => delay === 400).at(-1).callback();
  // The attempt has hung for a while: well past a healthy connect.
  harness.setNow(5_000);
  await probe();
  await settleTwice(harness);
  assert.equal(harness.sockets.length, hanging, 'while the server does not answer, the attempt waits');

  frozen = false;
  await probe();
  await settleTwice(harness);
  await settleTwice(harness);
  assert.equal(harness.sockets.length, hanging + 1, 'the server answered: a fresh attempt at once');
  assert.ok(probes.every((url) => url === '/playback/state'));
  assert.equal(harness.sockets.at(-1).readyState, 1, 'the fresh attempt opened');
  assert.ok(harness.sockets.at(-1).sent.some(({ type }) => type === 'open'), 'and the song goes on on it');
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

// After a minute of 502s, another song pressed in it played 4.8-18 s after the
// server answered: the reconnect waited out 2 s, then the claim waited out its own 2 s retry. Attempts
// the network refuses are retried every second, and the reopened socket has the claim ask at once.
test('a socket that reopens after an outage has a claim waiting out its retry ask at once', async () => {
  let serverBack = false;
  let retriedNow = 0;
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1 && !serverBack,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  harness.context.retryUnansweredPlaybackClaimNow = () => { retriedNow += 1; return true; };
  await startLocallySeekable(harness, 100_000);
  await harness.api.resume();
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  const delays = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const retry = timers.pending().find(({ delay }) => delay <= 2_000);
    delays.push(retry.delay);
    timers.fire(retry);
    await settleTwice(harness);
  }
  assert.deepEqual(delays, [500, 1_000, 1_000, 1_000], 'refused attempts are retried every second');
  assert.equal(retriedNow, 0);

  serverBack = true;
  timers.fire(timers.pending().find(({ delay }) => delay <= 2_000));
  await settleTwice(harness);
  assert.equal(harness.sockets.at(-1).readyState, 1);
  assert.equal(retriedNow, 1, 'the claim asks as soon as the socket is back');
});

// After a minute of tunnel 530 handshakes, Chromium held each new socket 1-5 s before sending it,
// past its 4 s deadline, and one press played nothing for 8 s after the server answered (hosted
// FTC-PLAYBACK-OFFLINE-005). A retry asks over HTTP first: no socket while the browser is offline or
// the tunnel answers without its server, and one on the first answer.
test('a reconnect retry opens no socket while offline or while the tunnel answers 530, and one on the first answer', async () => {
  let status = 530;
  const asked = [];
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count === 2,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async (url) => {
      asked.push(url);
      return { ok: status < 400, status, json: async () => ({}) };
    },
  });
  await startLocallySeekable(harness, 100_000);
  await harness.api.resume();
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 2, 'the lost socket is replaced at once');
  const retry = async () => {
    timers.fire(timers.pending().find(({ delay }) => delay <= 1_000));
    await settleTwice(harness);
  };

  for (let attempt = 0; attempt < 5; attempt += 1) await retry();
  assert.equal(harness.sockets.length, 2, 'no socket while the tunnel answers 530');
  assert.deepEqual(asked, Array(5).fill('/playback/state'), 'one question per retry');

  status = 200;
  harness.context.window.navigator = { onLine: false };
  for (let attempt = 0; attempt < 3; attempt += 1) await retry();
  assert.equal(harness.sockets.length, 2, 'no socket while offline');
  assert.equal(asked.length, 5, 'and no question either');

  harness.context.window.navigator = { onLine: true };
  await retry();
  assert.equal(harness.sockets.length, 3, 'the first answer opens one socket');
  assert.equal(harness.sockets.at(-1).readyState, 1);
  assert.ok(harness.sockets.at(-1).sent.some(({ type }) => type === 'open'), 'and the song goes on on it');
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

// Once the server answered again, every probe replaced the attempt then
// connecting, which takes 1.6-2 s through the tunnel, so no socket ever opened. The attempt a probe
// starts is on the network that answers and is left to connect; another is replaced only once it
// has hung for 3 s.
test('a reconnect that a probe started is left to connect, however slowly, while the server answers', async () => {
  let reachable = false;
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => (count > 1 ? 'hang' : false),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async () => {
      if (!reachable) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await startLocallySeekable(harness, 100_000);
  await harness.api.resume();
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  const probe = () => harness.intervals.filter(({ delay }) => delay === 400).at(-1)?.callback();

  harness.setNow(1_000);
  reachable = true;
  await probe();
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 2, 'an attempt connecting for a second is not replaced');

  harness.setNow(4_000);
  await probe();
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 3, 'one hung for 3 s is replaced');

  for (let now = 5_500; now <= 9_000; now += 1_500) {
    harness.setNow(now);
    await probe();
    await settleTwice(harness);
  }
  assert.equal(harness.sockets.length, 3, 'the attempt the probe started is left to connect');
  assert.equal(harness.sockets.at(-1).closeCalls, 0);
});

// The app notices at once that the network is back. After Wi-Fi returns a tunnel answers 530 for minutes, then 200. Every 530 is still
// unreachable, the server is asked again on every tick without backing off, and the first 200
// replaces the hung attempt on that tick.
test('a hung reconnect is replaced on the first good answer after a run of tunnel 530s, asked every tick', async () => {
  let status = 530;
  const asked = [];
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => (count === 2 ? 'hang' : false),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async (url) => {
      asked.push(harness.context.performance.now());
      return { ok: status < 400, status, json: async () => ({}) };
    },
  });
  await startLocallySeekable(harness, 100_000);
  await harness.api.resume();
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 2);
  const probe = () => harness.intervals.filter(({ delay }) => delay === 400).at(-1).callback();

  for (let now = 400; now <= 20_000; now += 400) {
    harness.setNow(now);
    await probe();
    await settleTwice(harness);
  }
  assert.equal(harness.sockets.length, 2, 'a 530 is not an answer: the attempt is not replaced');
  const afterHang = asked.filter((at) => at >= 3_000);
  assert.ok(afterHang.length >= 40, `asked on every tick once the attempt hung: ${afterHang.length}`);
  assert.ok(afterHang.every((at, index) => index === 0 || at - afterHang[index - 1] === 400), 'never backing off');

  status = 200;
  harness.setNow(20_400);
  await probe();
  await settleTwice(harness);
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 3, 'the first 200 replaces the hung attempt on that tick');
  assert.equal(harness.sockets.at(-1).readyState, 1);
  assert.ok(harness.sockets.at(-1).sent.some(({ type }) => type === 'open'), 'and the song goes on on it');
});

// After a 10 s outage another song pressed at once played 8.4 s later, while
// an attempt begun during the outage hung out its time. A press is a fresh reason to try: the attempt
// begun before it is replaced at once.
test('a press on another song while a reconnect hangs replaces that attempt at once', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => (count === 2 ? 'hang' : false),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  await harness.api.resume();
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 2);
  assert.equal(harness.sockets[1].readyState, 0, 'the attempt begun in the outage hangs');

  void harness.api.start(makeTrack('02.mp3'));
  await settleTwice(harness);
  await settleTwice(harness);
  assert.equal(harness.sockets[1].closeCalls, 1, 'the hanging attempt is given up');
  assert.equal(harness.sockets.length, 3, 'a fresh attempt starts at once');
  const opened = harness.sockets[2].sent.filter(({ type }) => type === 'open').at(-1);
  assert.equal(opened?.path, makeTrack('02.mp3').path);
});

test('a refused socket still stops playback with an error', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  harness.sockets[0].unexpectedClose({ code: 4401, reason: 'unauthenticated' });
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.api.snapshot().mode, 'error');
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

// A browser that has played a song at 44.1 kHz: its starts guess that rate instead of asking.
const PLAYED_AT_44_100 = {
  getLocalStorageItem: (key) => (key === 'albumhaven.playbackSampleRate.v1' ? '44100' : ''),
};

test('tracks play in a context at their own sample rate with rate-scaled buffers', async () => {
  const harness = createEngineHarness({ trackSampleRates: new Map(), trackSampleRate: () => 44_100 });
  const track = makeTrack();

  await harness.api.start(track, { startSeconds: 2 });

  assert.equal(harness.contexts[0].sampleRate, 44_100);
  const open = harness.sent('open')[0];
  assert.equal(open.sampleRate, 44_100);
  assert.equal(open.startFrame, 88_200);
  const configure = harness.portMessages('configure')[0];
  assert.equal(configure.sampleRate, 44_100);
  assert.equal(configure.currentCapacityFrames, 529_200);
  assert.equal(configure.startupBufferFrames, 88_200);
  acceptMetadata(harness, open, { sampleRate: 44_100 });
  assert.equal(harness.api.snapshot().sampleRate, 44_100);
});

test('a queued track at another rate opens no continuity and is handed over on ended', async () => {
  const ended = [];
  
  const harness = createEngineHarness({
    ...PLAYED_AT_44_100,
    trackSampleRates: new Map(),
    trackSampleRate: (path) => (path.endsWith('next.flac') ? 96_000 : 44_100),
    handleStreamingPlaybackEnded: (event) => ended.push(structuredClone(event)),
  });
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current, { sampleRate: 44_100 });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 1,
  });

  harness.engine.diagnostics.bufferedFrames.current = 44_100;
  const nextTrack = makeTrack('next.flac');
  await harness.api.continuity(nextTrack);
  assert.equal(harness.sockets[0].probes.length, 0, 'neither the start nor the next track waits for a probe');
  const refused = harness.sent('open').at(-1);
  assert.equal(refused.sampleRate, 44_100);
  harness.sockets[0].receive({
    type: 'rate-mismatch',
    generation: refused.generation,
    streamId: refused.streamId,
    sampleRate: 96_000,
    fallbackSampleRate: 48_000,
  });
  assert.equal(harness.engine.roles.continuity, null);
  assert.equal(harness.portMessages('expect-continuity').at(-1).active, false);

  harness.nodes[0].port.dispatch({
    type: 'ended',
    generation: current.generation,
    streamId: current.streamId,
    timelineFrame: 44_100,
  });
  assert.equal(ended[0].startNextTrackPath, nextTrack.path);

  await harness.api.start(nextTrack);
  assert.equal(harness.contexts.length, 2);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.contexts[1].sampleRate, 96_000);
  assert.equal(harness.sockets.length, 1, 'the one PCM socket survives the rate change');
  assert.equal(harness.sent('open').at(-1).sampleRate, 96_000);
});

test('a same-rate queued track keeps the context and opens gapless continuity', async () => {
  const harness = createEngineHarness({ trackSampleRates: new Map(), trackSampleRate: () => 44_100 });
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current, { sampleRate: 44_100 });
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: current.generation,
    streamId: current.streamId,
    renderedFrame: 0,
    contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 44_100;

  await harness.api.continuity(makeTrack('next.flac'));

  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.sent('open').at(-1).role, 'continuity');
  assert.equal(harness.sent('open').at(-1).sampleRate, 44_100);
});

test('the idle preparation verifies decoders and builds a suspended graph at the remembered rate', async () => {
  let decoderChecks = 0;
  const harness = createEngineHarness({
    trackSampleRates: new Map(),
    ensureStreamingDecoders: () => { decoderChecks += 1; return Promise.resolve(['mp3']); },
    getLocalStorageItem: (key) => (key === 'albumhaven.playbackSampleRate.v1' ? '48000' : ''),
  });

  await harness.context.prepareIdleStreamingPlayback();

  assert.equal(decoderChecks, 1);
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.contexts[0].sampleRate, 48_000);
  assert.equal(harness.contexts[0].state, 'suspended', 'nothing renders before a press');

  await harness.api.start(makeTrack('01.mp3'));
  assert.equal(harness.contexts.length, 1, 'the press reuses the idle graph');
  assert.equal(harness.sent('open')[0].sampleRate, 48_000);
});

test('inside the APK the idle preparation readies only the socket', async () => {
  let decoderChecks = 0;
  const harness = createEngineHarness({
    ensureStreamingDecoders: () => { decoderChecks += 1; return Promise.resolve(['mp3']); },
  });
  harness.context.isInsideAndroidShell = () => true;

  await harness.context.prepareIdleStreamingPlayback();

  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.contexts.length, 0, 'the native engine plays; no web audio graph is built');
  assert.equal(decoderChecks, 0);
});

test('the rate a song played at is remembered for the next page', async () => {
  const stored = new Map();
  const harness = createEngineHarness({
    trackSampleRates: new Map(),
    setLocalStorageItem: (key, value) => stored.set(key, value),
  });
  await harness.api.start(makeTrack('01.mp3'));
  // Nothing played yet, so the start asked the rate and opened at the answer.
  const open = harness.sent('open')[0];
  assert.equal(open.sampleRate, 48_000);

  acceptMetadata(harness, open, { sampleRate: 48_000 });

  assert.equal(stored.get('albumhaven.playbackSampleRate.v1'), '48000');
});

test('a start at an unknown rate opens at once at the rate this browser last played, without a probe', async () => {
  const harness = createEngineHarness({ ...PLAYED_AT_44_100, trackSampleRates: new Map() });

  await harness.api.start(makeTrack('01.mp3'));

  assert.equal(harness.sockets[0].probes.length, 0);
  assert.equal(harness.contexts[0].sampleRate, 44_100);
  assert.equal(harness.sent('open')[0].sampleRate, 44_100);
});

test('a browser that has played no song asks the rate first and opens once, even over an idle graph', async () => {
  const harness = createEngineHarness({ trackSampleRates: new Map() });
  await harness.context.prepareIdleStreamingPlayback();

  await harness.api.start(makeTrack('01.mp3'));

  assert.equal(harness.sockets[0].probes.length, 1);
  assert.equal(harness.sent('open').length, 1);
  assert.equal(harness.sent('open')[0].sampleRate, 48_000);
});

test('a start the server refuses for its rate starts again at the reported rate', async () => {
  const harness = createEngineHarness({ ...PLAYED_AT_44_100, trackSampleRates: new Map() });
  const track = makeTrack('01.flac');
  await harness.api.start(track, { startSeconds: 2 });
  const guessed = harness.sent('open')[0];
  assert.equal(guessed.startFrame, 88_200);

  harness.sockets[0].receive({
    type: 'rate-mismatch',
    generation: guessed.generation,
    streamId: guessed.streamId,
    sampleRate: 96_000,
    fallbackSampleRate: 48_000,
  });
  await harness.settle();

  assert.equal(harness.engine.diagnostics.lastError, undefined);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.equal(harness.contexts[1].sampleRate, 96_000);
  assert.equal(harness.sockets.length, 1, 'the socket survives the rate change');
  assert.equal(harness.sent('close').length, 0, 'the refused stream was never opened');
  const restarted = harness.sent('open').at(-1);
  assert.equal(restarted.role, 'current');
  assert.equal(restarted.path, track.path);
  assert.equal(restarted.sampleRate, 96_000);
  assert.equal(restarted.startFrame, 192_000);
  assert.equal(harness.engine.roles.current.streamId, restarted.streamId);
  assert.equal(harness.contexts[1].state, 'running');
});

test('a paused start at an unknown rate asks the rate first and opens once', async () => {
  const harness = createEngineHarness({ trackSampleRates: new Map() });

  const restored = await harness.api.start(makeTrack('01.flac'), { startSeconds: 2, autoplay: false });

  assert.equal(harness.sockets[0].probes.length, 1);
  assert.equal(harness.sent('open').length, 1);
  assert.equal(harness.sent('open')[0].sampleRate, 48_000);
  assert.equal(restored.generation, 1);
  assert.equal(harness.api.snapshot().paused, true);
});

test('a guessed start paused before its refusal starts again paused', async () => {
  const harness = createEngineHarness({ ...PLAYED_AT_44_100, trackSampleRates: new Map() });
  await harness.api.start(makeTrack('01.flac'));
  const guessed = harness.sent('open')[0];
  await harness.api.pause();

  harness.sockets[0].receive({
    type: 'rate-mismatch',
    generation: guessed.generation,
    streamId: guessed.streamId,
    sampleRate: 48_000,
    fallbackSampleRate: 48_000,
  });
  await harness.settle();

  assert.equal(harness.sent('open').at(-1).sampleRate, 48_000);
  assert.equal(harness.engine.mode, 'paused');
  assert.equal(harness.api.snapshot().paused, true);
});

function encodedFrame(open, sequence, bytes) {
  const buffer = new ArrayBuffer(24 + bytes.length);
  const view = new DataView(buffer);
  [65, 72, 80, 67].forEach((value, index) => view.setUint8(index, value));
  view.setUint8(4, 2);
  view.setUint8(5, open.role === 'current' ? 0 : 1);
  view.setUint32(8, open.generation, false);
  view.setUint32(12, open.streamId, false);
  view.setUint32(16, sequence, false);
  view.setUint32(20, bytes.length, false);
  new Uint8Array(buffer, 24).set(bytes);
  return buffer;
}

function rampDecoder(framesPerPacket) {
  let nextSample = 0;
  return () => ({
    ready: Promise.resolve(),
    free() {},
    decode() {
      const left = Float32Array.from({ length: framesPerPacket }, () => (nextSample += 1) / 1_000);
      return { channelData: [left, left], samplesDecoded: framesPerPacket };
    },
  });
}

function encodedHarness(options = {}) {
  const harness = createEngineHarness({
    createStreamingDecoder: rampDecoder(1_152),
    ...options,
  });
  harness.engine.encodedCodecs = ['mp3', 'flac'];
  return harness;
}

async function startEncoded(harness, track, metadata = {}) {
  await harness.api.start(track);
  const open = harness.sent('open').at(-1);
  acceptMetadata(harness, open, {
    codec: 'mp3', skipFrames: 1_105, totalFrames: 2_000, ...metadata,
  });
  await harness.settle();
  return open;
}

test('encoded streams advertise codecs and keep exactly the samples the server maps', async () => {
  const harness = encodedHarness();
  const open = await startEncoded(harness, makeTrack('01.mp3'));
  assert.deepEqual(open.codecs, ['mp3', 'flac']);

  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(100)));
  harness.sockets[0].receive(encodedFrame(open, 1, new Uint8Array(100)));
  harness.sockets[0].receive(encodedFrame(open, 2, new Uint8Array(100)));
  await harness.settle();
  harness.sockets[0].receive({
    type: 'eos',
    generation: open.generation,
    streamId: open.streamId,
    role: 'current',
    emittedFrames: 2_000,
    authoritativeTotalFrames: 2_000,
  });
  await harness.settle();

  const enqueued = harness.portMessages('enqueue');
  const left = enqueued.flatMap(({ pcm }) => [...pcm].filter((_, index) => index % 2 === 0));
  assert.equal(left.length, 2_000, 'the map decides the count, not the decoder');
  assert.ok(Math.abs(left[0] - 1.106) < 1e-5, 'the skipped decoder samples never play');
  assert.deepEqual(enqueued.map(({ sequence }) => sequence), enqueued.map((_, index) => index));
  const eos = harness.portMessages('eos').at(-1);
  assert.equal(eos.emittedFrames, 2_000);
  assert.equal(eos.authoritativeTotalFrames, 2_000);
  assert.equal(harness.engine.diagnostics.decoderFallback, undefined);
});

test('audio the server sends on open counts as already requested', async () => {
  const harness = encodedHarness();
  const open = await startEncoded(harness, makeTrack('01.mp3'), {
    initialCreditBytes: 64 * 1024,
  });

  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(64 * 1024)));

  assert.equal(harness.engine.diagnostics.lastError, undefined);
});

test('encoded bytes are requested separately from decoded ring credit', async () => {
  const harness = encodedHarness();
  const open = await startEncoded(harness, makeTrack('01.mp3'));

  const credit = harness.sent('credit');
  assert.equal(credit.length, 4, 'a bounded window of byte requests is in flight');
  assert.ok(credit.every(({ frames }) => frames === 64 * 1024));

  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(64 * 1024)));
  await harness.settle();
  assert.equal(harness.sent('credit').length, 5, 'each answered request is replaced, never more');
});

test('encoded bytes beyond granted credit are a protocol failure', async () => {
  const harness = encodedHarness();
  const open = await startEncoded(harness, makeTrack('01.mp3'));

  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array((256 * 1024) + 1)));

  assert.match(harness.engine.diagnostics.lastError.message, /byte credit/);
});

test('a decoder failure replays the track from its position on server decoding', async () => {
  const harness = encodedHarness({
    createStreamingDecoder: () => ({
      ready: Promise.resolve(),
      free() {},
      decode() { throw new Error('decoder fault'); },
    }),
  });
  const open = await startEncoded(harness, makeTrack('01.mp3'));
  harness.engine.snapshot.currentTime = 12;

  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(100)));
  await harness.settle();

  assert.equal(harness.engine.diagnostics.decoderFallback, 'decode-error');
  assert.deepEqual(harness.sent('decoder-fallback').map(({ reason }) => reason), ['decode-error']);
  const replay = harness.sent('open').at(-1);
  assert.equal(replay.path, open.path);
  assert.equal(replay.startFrame, 576_000);
  assert.equal(replay.codecs, undefined, 'the replay is decoded by the server');
});

test('a short decode is reported and later tracks use server decoding', async () => {
  const harness = encodedHarness();
  const open = await startEncoded(harness, makeTrack('01.mp3'), { totalFrames: 5_000 });

  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(100)));
  await harness.settle();
  harness.sockets[0].receive({
    type: 'eos',
    generation: open.generation,
    streamId: open.streamId,
    role: 'current',
    emittedFrames: 5_000,
    authoritativeTotalFrames: 5_000,
  });
  await harness.settle();

  assert.equal(harness.engine.diagnostics.decoderFallback, 'short-decode');
  assert.equal(harness.engine.encodedCodecs.length, 0);
  assert.equal(harness.portMessages('eos').at(-1).emittedFrames, 47);
});

test('FLAC drops to 320 kbps after a recent stall and never changes an MP3', async () => {
  const harness = encodedHarness({
    trackSampleRates: new Map(),
    trackSampleRate: () => 96_000,
  });
  harness.engine.lastStallAtMs = 1_000;

  await harness.api.start(makeTrack('hi.flac'));
  const open = harness.sent('open').at(-1);
  assert.equal(open.quality, '320');

  await harness.api.stop();
  harness.engine.encodedCodecs = ['mp3', 'flac'];
  await harness.api.start(makeTrack('song.mp3'));
  assert.equal(harness.sent('open').at(-1).quality, undefined);
});

test('a decoder failure never carries a 320 kbps request to server decoding', async () => {
  const harness = encodedHarness({
    trackSampleRates: new Map(),
    trackSampleRate: () => 44_100,
    createStreamingDecoder: () => ({
      ready: Promise.resolve(),
      free() {},
      decode() { throw new Error('decoder fault'); },
    }),
  });
  harness.engine.qualityPreference = '320';
  const open = await startEncoded(harness, makeTrack('hi.flac'), { sampleRate: 44_100 });
  assert.equal(open.quality, '320');

  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(100)));
  await harness.settle();

  const replay = harness.sent('open').at(-1);
  assert.notEqual(replay.streamId, open.streamId);
  assert.equal(replay.quality, undefined);
  assert.equal(replay.codecs, undefined);
});

test('a good connection keeps FLAC at original quality', async () => {
  const harness = encodedHarness();

  await harness.api.start(makeTrack('hi.flac'));

  assert.equal(harness.sent('open').at(-1).quality, undefined);
});

test('a FLAC start on a measured slow connection still reads its size before choosing quality', async () => {
  const harness = encodedHarness({ trackSampleRates: new Map(), trackSampleRate: () => 44_100 });
  harness.engine.transferBytes = 125_000;
  harness.engine.transferMs = 1_000;
  const track = makeTrack('hi.flac');

  await harness.api.start(track);

  assert.deepEqual(harness.sockets[0].probes.map(({ path }) => path), [track.path]);
  assert.equal(harness.sent('open').at(-1).sampleRate, 44_100);
});

test('a manual quality preference overrides the connection measurement', async () => {
  const harness = encodedHarness();
  harness.engine.lastStallAtMs = 1_000;
  harness.engine.qualityPreference = 'original';

  await harness.api.start(makeTrack('hi.flac'));

  assert.equal(harness.sent('open').at(-1).quality, undefined);
});

test('a decoder failure during a seek restarts at the seek target instead of hanging', async () => {
  let decodeCalls = 0;
  const harness = encodedHarness({
    createStreamingDecoder: () => ({
      ready: Promise.resolve(),
      free() {},
      decode() {
        decodeCalls += 1;
        throw new Error('decoder fault');
      },
    }),
  });
  const open = await startEncoded(harness, makeTrack('01.mp3'));
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: open.generation,
    streamId: open.streamId,
    renderedFrame: 0,
    contextTime: 1,
  });
  harness.engine.roles.current.encoded = null;

  await harness.api.seek(30);
  const seek = harness.sent('open').at(-1);
  acceptMetadata(harness, seek, { codec: 'mp3', skipFrames: 0, totalFrames: 2_000 });
  await harness.settle();
  harness.sockets[0].receive(encodedFrame(seek, 0, new Uint8Array(100)));
  await harness.settle();

  assert.equal(decodeCalls, 1);
  assert.equal(harness.engine.pendingSeek, null);
  const replay = harness.sent('open').at(-1);
  assert.equal(replay.startFrame, 1_440_000);
  assert.equal(replay.codecs, undefined);
});

test('padding after the last mapped sample never delays end of stream', async () => {
  const harness = encodedHarness();
  const open = await startEncoded(harness, makeTrack('01.mp3'), { skipFrames: 0, totalFrames: 1_152 });
  harness.engine.roles.current.encoded.localCreditFrames = 1_152;

  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(100)));
  await harness.settle();
  harness.engine.roles.current.encoded.localCreditFrames = 0;
  harness.sockets[0].receive(encodedFrame(open, 1, new Uint8Array(100)));
  harness.sockets[0].receive({
    type: 'eos',
    generation: open.generation,
    streamId: open.streamId,
    role: 'current',
    emittedFrames: 1_152,
    authoritativeTotalFrames: 1_152,
  });
  await harness.settle();

  assert.equal(harness.portMessages('eos').at(-1).emittedFrames, 1_152);
});

test('music playback asks for large output buffers', async () => {
  const harness = createEngineHarness();

  await harness.api.start(makeTrack());

  assert.equal(harness.contexts[0].latencyHint, 'playback');
});

test('audio output details are reported once and again only when dropouts grow', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  const open = harness.sent('open')[0];
  acceptMetadata(harness, open);
  const context = harness.contexts[0];
  context.baseLatency = 0.05;
  context.playbackStats = { underrunEvents: 0, underrunDuration: 0 };
  const position = () => {
    harness.sockets[0].receive({ type: 'heartbeat' });
    harness.nodes[0].port.dispatch({
      type: 'position',
      generation: open.generation,
      streamId: open.streamId,
      timelineFrame: 48_000,
    });
  };

  harness.setNow(10_000);
  position();
  harness.setNow(16_000);
  position();
  assert.equal(harness.sent('output-report').length, 1);
  assert.equal(harness.sent('output-report')[0].baseLatencyMs, 50);

  context.playbackStats = { underrunEvents: 3, underrunDuration: 0.09 };
  harness.setNow(22_000);
  position();

  const report = harness.sent('output-report').at(-1);
  assert.equal(report.underruns, 3);
  assert.equal(report.underrunMs, 90);
  assert.equal(report.statsAvailable, true);
});

test('a prepared replacement checks the waveform cache before audio is ready', async () => {
  const probes = [];
  const harness = createEngineHarness({
    probeCachedWaveformPeaks: (path, generation) => probes.push({ path, generation }),
  });
  await harness.api.start(makeTrack('01.flac'));
  const open = harness.sent('open')[0];
  acceptMetadata(harness, open);
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: open.generation,
    streamId: open.streamId,
    renderedFrame: 0,
    contextTime: 1,
  });
  harness.engine.diagnostics.bufferedFrames.current = 96_000;
  probes.length = 0;

  void harness.api.start(makeTrack('02.flac'));
  await harness.settle();

  assert.deepEqual(JSON.parse(JSON.stringify(probes)), [
    { path: 'C:/Music/Album/02.flac', generation: open.generation },
  ]);
});

test('a seek stops the old position downloading so its audio arrives first', async () => {
  const harness = encodedHarness();
  const open = await startEncoded(harness, makeTrack('01.mp3'));
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: open.generation,
    streamId: open.streamId,
    renderedFrame: 0,
    contextTime: 1,
  });
  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(64 * 1024)));
  await harness.settle();
  const creditsBeforeSeek = harness.sent('credit').filter(({ streamId }) => streamId === open.streamId);

  await harness.api.seek(30);
  harness.sockets[0].receive(encodedFrame(open, 1, new Uint8Array(100)));
  await harness.settle();

  const creditsAfterSeek = harness.sent('credit').filter(({ streamId }) => streamId === open.streamId);
  assert.equal(creditsAfterSeek.length, creditsBeforeSeek.length);
});

test('a switch to an unknown encoded track opens at once and needs one second of head', async () => {
  const harness = encodedHarness({
    trackSampleRates: new Map([[makeTrack('01.mp3').path, 48_000]]),
    trackSampleRate: () => 48_000,
  });
  await harness.api.start(makeTrack('01.mp3'));
  const open = harness.sent('open')[0];
  acceptMetadata(harness, open, { codec: 'mp3', skipFrames: 0, totalFrames: 2_000_000 });
  await harness.settle();
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: open.generation,
    streamId: open.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  const probes = harness.sockets[0].probes.length;

  void harness.api.start(makeTrack('02.mp3'));
  await harness.settle();

  assert.equal(harness.sockets[0].probes.length, probes, 'a switch never waits for a probe');
  const replacement = harness.sent('open').at(-1);
  assert.equal(replacement.role, 'continuity');
  acceptMetadata(harness, replacement, { codec: 'mp3', skipFrames: 0, totalFrames: 2_000_000 });
  await harness.settle();
  assert.equal(harness.engine.roles.continuity.targetBufferFrames, 48_000);
});

test('a refused switch restarts cleanly at the track rate', async () => {
  const harness = encodedHarness({ trackSampleRates: new Map(), trackSampleRate: () => 48_000 });
  await harness.api.start(makeTrack('01.mp3'));
  const open = harness.sent('open')[0];
  acceptMetadata(harness, open, { codec: 'mp3', skipFrames: 0, totalFrames: 2_000_000 });
  await harness.settle();
  harness.nodes[0].port.dispatch({
    type: 'first-frame',
    generation: open.generation,
    streamId: open.streamId,
    renderedFrame: 0,
    contextTime: 12.5,
  });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;

  const switching = harness.api.start(makeTrack('02.mp3'));
  await harness.settle();
  const refused = harness.sent('open').at(-1);
  harness.sockets[0].receive({
    type: 'rate-mismatch',
    generation: refused.generation,
    streamId: refused.streamId,
    sampleRate: 44_100,
    fallbackSampleRate: 44_100,
  });
  const started = await switching;

  assert.equal(harness.contexts.at(-1).sampleRate, 44_100);
  assert.equal(harness.sent('open').at(-1).role, 'current');
  assert.equal(harness.sent('open').at(-1).sampleRate, 44_100);
  assert.equal(started.track.path, makeTrack('02.mp3').path);
});

// The fake stream: 100 bytes per 1,152-sample MP3 frame, every byte naming its own offset.
function fakeSeekTable(open, frames = 2_000_000) {
  const samples = [];
  for (let sample = 0; sample < frames; sample += 1_152) samples.push(sample);
  return {
    type: 'seek-table',
    generation: open.generation,
    streamId: open.streamId,
    prefixBytes: 0,
    prerollFrames: 8 * 1_152,
    offsets: [...samples.map((_, index) => index * 100), samples.length * 100],
    samples: [...samples, frames],
  };
}

function recordingDecoders() {
  const decoders = [];
  const create = () => {
    const decoder = { inputs: [], ready: Promise.resolve(), free() {}, carried: 0 };
    decoder.decode = (bytes) => {
      decoder.inputs.push(bytes);
      // A frame split between two inputs decodes with the second, as a streaming decoder's does.
      const available = decoder.carried + bytes.length;
      decoder.carried = available % 100;
      const samplesDecoded = Math.floor(available / 100) * 1_152;
      const left = new Float32Array(samplesDecoded);
      return { channelData: [left, left], samplesDecoded };
    };
    decoders.push(decoder);
    return decoder;
  };
  return { decoders, create };
}

/** The half-second liveness check of the engine's current socket. */
function liveness(harness) {
  const checks = harness.intervals.filter(({ delay }) => delay === 500);
  return checks.at(-1);
}

/** Runs the liveness check on time, every half second, from [fromMs] to [untilMs]. */
function checkLivenessUntil(harness, fromMs, untilMs) {
  for (let now = fromMs; now <= untilMs; now += 500) {
    harness.setNow(now);
    liveness(harness).callback();
  }
}

async function startLocallySeekable(harness, receivedBytes) {
  const open = await startEncoded(harness, makeTrack('01.mp3'), {
    skipFrames: 0, totalFrames: 2_000_000, initialCreditBytes: 400_000,
  });
  harness.sockets[0].receive(fakeSeekTable(open));
  harness.sockets[0].receive(encodedFrame(open, 0, Uint8Array.from({ length: receivedBytes }, (_, index) => index % 251)));
  await harness.settle();
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: open.generation, streamId: open.streamId, renderedFrame: 0, contextTime: 1,
  });
  return open;
}

test('a seek inside the received bytes decodes them here, from the seek table, with no round trip', async () => {
  const { decoders, create } = recordingDecoders();
  const harness = encodedHarness({ createStreamingDecoder: create });
  const open = await startLocallySeekable(harness, 300_000);
  assert.equal(open.seekTable, true);
  const opens = harness.sent('open').length;

  await harness.api.seek(30);
  await harness.settle();

  assert.equal(harness.sent('open').length, opens, 'the server is not asked for the seek');
  const local = harness.engine.roles.continuity;
  assert.equal(local.local, true);
  assert.equal(harness.portMessages('reserve-seek').at(-1).streamId, local.streamId);
  // 30 s is sample 1,440,000: decoding starts eight frames early, at frame 1,242's bytes.
  const fed = decoders.at(-1).inputs;
  assert.equal(fed[0].length, 16 * 1024, 'one decode slice, not the rest of the song');
  assert.equal(fed[0][0], 124_200 % 251);

  harness.nodes[0].port.dispatch({
    type: 'seek-boundary',
    generation: open.generation,
    outgoingStreamId: open.streamId,
    incomingStreamId: local.streamId,
    renderedFrame: 128,
    timelineFrame: 1_440_000,
    silentFrames: 0,
  });
  assert.equal(harness.engine.roles.current, local);
  await harness.settle();
  assert.equal(harness.sent('promote').length, 0, 'the server stream stays its current one');
  assert.equal(harness.sent('close').length, 0);
  assert.equal(harness.engine.pendingPromotion, null);

  // Bytes the server keeps sending reach the role now reading the stream.
  harness.sockets[0].receive(encodedFrame(open, 1, new Uint8Array(100)));
  await harness.settle();
  assert.equal(local.encoded.queue.at(-1).length, 100, 'queued behind the received bytes not yet decoded');
  // Its credits still name the server's stream.
  assert.ok(harness.sent('credit').every(credit => credit.streamId === open.streamId));
});

// A seek shows the head at its new place at once. The rest of
// the song decoded in one call held the click's task, and the page's paint, for seconds.
test('a local seek decodes only what its credit asks, a slice at a time, before the click returns', async () => {
  const { decoders, create } = recordingDecoders();
  const harness = encodedHarness({ createStreamingDecoder: create });
  await startLocallySeekable(harness, 300_000);
  const decodersBefore = decoders.length;

  void harness.api.seek(10);
  // The seek's own decoder, reading the received bytes.
  assert.equal(decoders.length, decodersBefore + 1);
  const decoder = decoders.at(-1);
  const inClick = [...decoder.inputs];
  await harness.settle();
  const fed = decoder.inputs;

  assert.equal(harness.engine.roles.continuity.local, true);
  assert.ok(inClick.every((bytes) => bytes.length <= 16 * 1024), 'the click decodes at most a slice per call');
  assert.ok(fed.every((bytes) => bytes.length <= 16 * 1024));
  const decodedBytes = fed.reduce((total, bytes) => total + bytes.length, 0);
  // 10 s starts at byte 41,000 (eight frames early): the rest of the received song is 259,000 bytes.
  assert.ok(decodedBytes <= 2 * 16 * 1024, `decoded ${decodedBytes} bytes for a quarter second of credit`);
  assert.equal(harness.engine.snapshot.currentTime, 10, 'the playhead is at the new place');
});

// At 4x CPU a press on another song went unanswered for 15 s while every
// decoded chunk serialised the engine snapshot onto the page root. The snapshot is written once a frame.
test('the diagnostics snapshot is written at most once per animation frame, however often the engine changes', async () => {
  const writes = [];
  const frames = [];
  const { create } = recordingDecoders();
  const harness = encodedHarness({
    createStreamingDecoder: create,
    document: { documentElement: { setAttribute: (name, value) => writes.push({ name, value }) } },
    requestAnimationFrame: (callback) => frames.push(callback),
  });
  await startLocallySeekable(harness, 300_000);
  void harness.api.seek(10);
  await harness.settle();
  assert.equal(writes.length, 0, 'nothing is written before the frame');
  assert.equal(frames.length, 1, 'one frame is asked for, however many changes came');

  frames.shift()();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'data-streaming-diagnostics');
  assert.equal(JSON.parse(writes[0].value).currentTime, 10, 'the frame writes the latest snapshot');

  harness.context.publishStreamingDiagnostics();
  harness.context.publishStreamingDiagnostics();
  assert.equal(frames.length, 1, 'the next changes ask for the next frame once');
});

test('a seek past the received bytes still asks the server', async () => {
  const { create } = recordingDecoders();
  const harness = encodedHarness({ createStreamingDecoder: create });
  await startLocallySeekable(harness, 100_000);
  const opens = harness.sent('open').length;

  await harness.api.seek(30);

  assert.equal(harness.sent('open').length, opens + 1);
  assert.equal(harness.sent('open').at(-1).startFrame, 1_440_000);
  assert.notEqual(harness.engine.roles.continuity.local, true);
});

test('the web lookup answers the shared seek-table vectors exactly as the server does', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'playback-seek-table-v1.json'), 'utf8'));
  const harness = encodedHarness();
  let checked = 0;
  for (const section of [fixture, fixture.flac, fixture.seekStream]) {
    for (const vector of section.cases) {
      const window = harness.context.lookupStreamingSeekTable(section.table, {
        initialSkip: section.initialSkip,
        initialTotal: section.initialTotal,
        streamStart: section.streamStart,
        target: vector.target,
        receivedBytes: vector.receivedBytes,
        ended: vector.ended,
      });
      assert.deepEqual(window && JSON.parse(JSON.stringify(window)), vector.window, JSON.stringify(vector));
      checked += 1;
    }
  }
  assert.ok(checked > 10);
});

test('an open socket sends a keepalive every 25 seconds and stops with its socket', async () => {
  const harness = createEngineHarness();
  await harness.api.start(makeTrack());
  await harness.settle();
  const keepalive = harness.intervals.find(({ delay }) => delay === 25_000);
  assert.ok(keepalive);

  keepalive.callback();
  assert.equal(harness.sent('keepalive').length, 1);
  assert.deepEqual(Object.keys(harness.sent('keepalive')[0]), ['type']);

  harness.engine.socket = null;
  keepalive.callback();
  assert.equal(harness.sent('keepalive').length, 1);
});

function withTrackCache(harness, stored = new Map()) {
  const kept = [];
  Object.assign(harness.context, {
    streamingTrackCacheKey: (track, quality) => `${track.path}|${quality || 'original'}`,
    loadStreamingCachedTrack: async key => stored.get(key) || null,
    keepStreamingCachedTrack: (key, entry) => kept.push({ key, entry }),
  });
  return kept;
}

test('a whole stream is kept for its next play, with its map and seek table', async () => {
  const { create } = recordingDecoders();
  const harness = encodedHarness({ createStreamingDecoder: create });
  const kept = withTrackCache(harness);
  const open = await startEncoded(harness, makeTrack('01.mp3'), {
    skipFrames: 1_105, totalFrames: 20_000, initialCreditBytes: 4_000,
  });
  harness.sockets[0].receive(fakeSeekTable(open, 22_000));
  harness.sockets[0].receive(encodedFrame(open, 0, Uint8Array.from({ length: 2_000 }, (_, index) => index % 251)));
  harness.sockets[0].receive({
    type: 'eos', generation: open.generation, streamId: open.streamId, role: 'current',
    emittedFrames: 20_000, authoritativeTotalFrames: 20_000,
  });
  await harness.settle();

  assert.equal(kept.length, 1);
  assert.equal(kept[0].key, `${makeTrack('01.mp3').path}|original`);
  const { entry } = kept[0];
  assert.deepEqual([entry.codec, entry.sampleRate, entry.skipFrames, entry.totalFrames, entry.authoritativeTotalFrames],
    ['mp3', 48_000, 1_105, 20_000, 20_000]);
  assert.equal(entry.bytes.length, 2_000);
  assert.equal(entry.bytes[300], 300 % 251);
  assert.equal(entry.table.samples.at(-1), 22_000);
});

test('a kept track plays with no server stream, and leaving it closes nothing', async () => {
  const { decoders, create } = recordingDecoders();
  const harness = encodedHarness({ createStreamingDecoder: create });
  const track = makeTrack('01.mp3');
  const bytes = Uint8Array.from({ length: 2_000 }, (_, index) => index % 251);
  withTrackCache(harness, new Map([[`${track.path}|original`, {
    codec: 'mp3', sampleRate: 48_000, skipFrames: 0, totalFrames: 20_000, authoritativeTotalFrames: 20_000,
    table: fakeSeekTable({ generation: 1, streamId: 1 }, 20_000), bytes,
  }]]));

  await harness.api.start(track);
  await harness.settle();

  assert.equal(harness.sent('open').length, 0, 'the server is not asked for a kept track');
  const current = harness.engine.roles.current;
  assert.equal(current.cachedTrack !== undefined, true);
  assert.equal(harness.engine.diagnostics.cachedStarts, 1);
  assert.equal(decoders.at(-1).inputs[0].length, 2_000);
  assert.ok(harness.portMessages('enqueue').length > 0, 'its audio reaches the worklet');

  await harness.api.start(makeTrack('02.mp3'));
  assert.equal(harness.sent('close').length, 0);
  assert.equal(harness.sent('open').length, 1);
});

test('a browser cache that never answers does not hold the start of a track', async () => {
  const deadlines = [];
  const harness = createEngineHarness({
    setTimeout: (callback, delay) => {
      if (delay === 500) {
        deadlines.push(delay);
        Promise.resolve().then(callback);
        return 1;
      }
      return setTimeout(callback, delay);
    },
  });
  Object.assign(harness.context, {
    streamingTrackCacheKey: (track, quality) => `${track.path}|${quality || 'original'}`,
    loadStreamingCachedTrack: () => new Promise(() => {}),
    keepStreamingCachedTrack: () => {},
  });

  const start = harness.api.start(makeTrack());
  await harness.settle();

  assert.deepEqual(deadlines, [500]);
  assert.equal(harness.sent('open').length, 1, 'the track streams from the server instead');
  await start;
});

test('a browser cache that never answers does not hold the next song', async () => {
  const deadlines = [];
  const harness = createEngineHarness({
    setTimeout: (callback, delay) => {
      if (delay === 500) {
        deadlines.push(delay);
        Promise.resolve().then(callback);
        return 1;
      }
      return setTimeout(callback, delay);
    },
  });
  const next = makeTrack('02.flac');
  Object.assign(harness.context, {
    streamingTrackCacheKey: (track, quality) => `${track.path}|${quality || 'original'}`,
    loadStreamingCachedTrack: key => (key.startsWith(next.path) ? new Promise(() => {}) : Promise.resolve(null)),
    keepStreamingCachedTrack: () => {},
  });
  await harness.api.start(makeTrack());
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.sockets[0].receive({
    type: 'eos', generation: current.generation, streamId: current.streamId, role: 'current',
    emittedFrames: 10_000, authoritativeTotalFrames: 10_000,
  });

  const scheduling = harness.api.continuity(next);
  await harness.settle();

  assert.deepEqual(deadlines, [500, 500], 'the start and the next song each wait out the same deadline');
  assert.deepEqual(harness.sent('open').map(({ role }) => role), ['current', 'continuity'],
    'the next song streams from the server instead');
  await scheduling;
});

test('a kept track starts mid-track from its seek table', async () => {
  const { decoders, create } = recordingDecoders();
  const harness = encodedHarness({ createStreamingDecoder: create });
  const track = makeTrack('01.mp3');
  withTrackCache(harness, new Map([[`${track.path}|original`, {
    codec: 'mp3', sampleRate: 48_000, skipFrames: 0, totalFrames: 2_000_000, authoritativeTotalFrames: 2_000_000,
    table: fakeSeekTable({ generation: 1, streamId: 1 }), bytes: Uint8Array.from({ length: 173_700 }, (_, index) => index % 251),
  }]]));

  await harness.api.start(track, { startSeconds: 30 });
  await harness.settle();

  assert.equal(harness.sent('open').length, 0);
  assert.equal(decoders.at(-1).inputs[0][0], 124_200 % 251);
  assert.equal(decoders.at(-1).inputs[0].length, 16 * 1024, 'the kept bytes decode a slice at a time');
});

test('a successor prepared ahead is kept at the local audible boundary', async () => {
  const harness = encodedHarness();
  const kept = withTrackCache(harness);
  await harness.api.start(makeTrack('01.mp3'));
  const current = harness.sent('open')[0];
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId,
    renderedFrame: 0, contextTime: 1,
  });
  harness.sockets[0].receive({
    type: 'eos', generation: current.generation, streamId: current.streamId, role: 'current',
    emittedFrames: 10_000, authoritativeTotalFrames: 10_000,
  });
  await harness.api.continuity(makeTrack('02.mp3'));
  const continuity = harness.engine.roles.continuity;
  const wire = {
    track: makeTrack('02.mp3'), quality: 'original', codec: 'mp3', streamStart: 0, serverless: false,
    initialSkip: 0, initialTotal: 10_000, table: null, bytes: new Uint8Array(8), size: 8,
  };
  const eos = { authoritativeTotalFrames: 10_000 };
  continuity.encoded = { wire, eos };

  harness.context.keepStreamingWire(wire, eos, 'continuity');
  assert.deepEqual(kept, [], 'a song only fetched ahead is not kept');

  harness.nodes[0].port.dispatch({
    type: 'boundary', generation: current.generation,
    outgoingStreamId: current.streamId, incomingStreamId: continuity.streamId,
    renderedFrame: 10_000, timelineFrame: 0, capture: {},
  });
  assert.deepEqual(kept.map(({ key }) => key), [`${makeTrack('02.mp3').path}|original`]);
  harness.sockets[0].receive({
    type: 'promoted', generation: current.generation, streamId: continuity.streamId, role: 'current',
  });
  assert.equal(kept.length, 1, 'it is kept once');
});

// ---- Network switches: the received audio plays on and the stream is spliced back in ----
// These tests compare roles by stream id: a failing comparison of role objects renders their whole
// graph, decoded PCM included, which takes gigabytes.

function manualTimers() {
  const timers = [];
  return {
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay, cleared: false, fired: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
    pending: () => timers.filter(({ cleared, fired }) => !cleared && !fired),
    fire(timer) {
      timer.fired = true;
      timer.callback();
    },
  };
}

function receiveOn(socket, open, message) {
  socket.receive({ generation: open.generation, streamId: open.streamId, role: open.role, ...message });
}

function acceptEncodedMetadata(socket, open, changes = {}) {
  receiveOn(socket, open, {
    type: 'metadata', sampleRate: 48_000, channels: 2, codec: 'mp3', skipFrames: 0,
    totalFrames: 2_000_000 - open.startFrame, initialCreditBytes: 0, provisionalTotalFrames: 2_000_000,
    requestedStartFrame: open.startFrame, timelineStartFrame: open.startFrame, ...changes,
  });
}

async function settleTwice(harness) {
  await harness.settle();
  await harness.settle();
}

test('the web splice frame answers the shared seek-table vectors exactly as the server does', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'playback-seek-table-v1.json'), 'utf8'));
  const harness = encodedHarness();
  let checked = 0;
  for (const section of [fixture, fixture.flac, fixture.seekStream]) {
    for (const vector of section.wholeThroughCases) {
      const frame = harness.context.wholeThroughStreamingSeekTable(section.table, {
        initialSkip: section.initialSkip,
        initialTotal: section.initialTotal,
        streamStart: section.streamStart,
        receivedBytes: vector.receivedBytes,
      });
      assert.equal(frame, vector.frame, JSON.stringify(vector));
      checked += 1;
    }
  }
  assert.ok(checked > 10);
});

test('a network change after the whole song arrived plays it on and prepares its successor on the next socket', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  const open = await startLocallySeekable(harness, 173_700);
  receiveOn(harness.sockets[0], open, { type: 'eos', emittedFrames: 2_000_000, authoritativeTotalFrames: 2_000_000 });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.mp3'));
  await harness.settle();
  const next = harness.sent('open').at(-1);
  assert.equal(next.role, 'continuity');
  const current = harness.engine.roles.current;
  const sentOnLostSocket = harness.sockets[0].sent.length;

  harness.sockets[0].unexpectedClose();

  assert.equal(harness.engine.roles.current?.streamId, current.streamId, 'the song keeps playing');
  assert.equal(harness.contexts[0].closeCalls, 0);
  assert.equal(harness.nodes[0].disconnectCalls, 0);
  const detached = harness.api.snapshot();
  assert.notEqual(detached.mode, 'error');
  assert.equal(detached.paused, false);
  assert.equal(detached.diagnostics.transportDetaches, 1);
  assert.equal(detached.diagnostics.transportState, 'detached-offline');
  assert.equal(harness.engine.roles.continuity?.streamId ?? null, null, 'the successor was streaming on the lost socket');
  assert.equal(harness.portMessages('expect-continuity').at(-1).active, true, 'the song end waits for its successor');

  await settleTwice(harness);
  await settleTwice(harness);

  assert.equal(harness.sockets[0].sent.length, sentOnLostSocket, 'nothing is sent on the lost socket');
  assert.equal(harness.sockets.length, 2);
  const reopened = harness.sockets[1].sent.filter(({ type }) => type === 'open');
  assert.deepEqual(reopened.map(({ path: trackPath, role, startFrame }) => ({ trackPath, role, startFrame })),
    [{ trackPath: makeTrack('02.mp3').path, role: 'continuity', startFrame: 0 }]);
  assert.ok(harness.sockets[1].sent.every(({ streamId }) => streamId === undefined || streamId > next.streamId),
    'no control names a stream of the lost socket');
  assert.equal(harness.engine.roles.current?.streamId, current.streamId);
  assert.equal(harness.api.snapshot().diagnostics.transportState, 'connected');
});

test('a network change mid-song plays the received audio to a whole frame and splices the rest in there', async () => {
  const boundaries = [];
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    handleStreamingPlaybackBoundary: (event) => boundaries.push(event),
  });
  const open = await startLocallySeekable(harness, 100_000);
  const current = harness.engine.roles.current;
  const duration = harness.api.snapshot().duration;
  const sentOnLostSocket = harness.sockets[0].sent.length;

  harness.sockets[0].unexpectedClose();

  // Byte 100,000 starts seek point 1,000; one full stride short of it is seek point 999.
  const splice = 999 * 1_152;
  const detached = harness.api.snapshot();
  assert.equal(detached.diagnostics.lastSpliceFrame, splice);
  assert.equal(detached.diagnostics.transportState, 'detached-splice');
  assert.notEqual(detached.mode, 'error');
  assert.equal(harness.engine.roles.current?.streamId, current.streamId);
  assert.equal(current.encoded.eos.authoritativeTotalFrames, splice, 'the received stream ends at the splice frame');
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.portMessages('expect-continuity').at(-1))),
    { type: 'expect-continuity', generation: open.generation, active: true, timelineStartFrame: splice },
  );
  assert.equal(harness.contexts[0].closeCalls, 0);

  await settleTwice(harness);

  assert.equal(harness.sockets[0].sent.length, sentOnLostSocket);
  const spliceOpen = harness.sockets[1].sent.find(({ type }) => type === 'open');
  assert.deepEqual([spliceOpen.path, spliceOpen.role, spliceOpen.startFrame, spliceOpen.seekTable],
    [makeTrack('01.mp3').path, 'continuity', splice, true]);
  acceptEncodedMetadata(harness.sockets[1], spliceOpen);
  await harness.settle();

  harness.nodes[0].port.dispatch({
    type: 'boundary', generation: open.generation, outgoingStreamId: current.streamId,
    incomingStreamId: spliceOpen.streamId, renderedFrame: 50_000, timelineFrame: splice + 128,
    capture: { outgoing: { frames: 64 }, incoming: { frames: 64 } },
  });

  const joined = harness.api.snapshot();
  assert.equal(harness.engine.roles.current.streamId, spliceOpen.streamId);
  assert.equal(boundaries.length, 0, 'the player stays on the same song');
  assert.equal(joined.currentTime, (splice + 128) / 48_000);
  assert.equal(joined.duration, duration);
  assert.equal(joined.diagnostics.transportState, 'connected');
  assert.equal(joined.diagnostics.transportResumes, 1);
  const promote = harness.sockets[1].sent.find(({ type }) => type === 'promote');
  assert.equal(promote.streamId, spliceOpen.streamId);
  harness.nodes[0].port.dispatch({
    type: 'position', generation: open.generation, streamId: spliceOpen.streamId, timelineFrame: splice + 4_096,
  });
  assert.equal(harness.api.snapshot().currentTime, (splice + 4_096) / 48_000, 'the position keeps advancing from the splice');
});

test('the received stream cut at the splice frame delivers exactly its frames and keeps the song length', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  const open = await startLocallySeekable(harness, 100_000);
  const duration = harness.api.snapshot().duration;
  harness.sockets[0].unexpectedClose();
  const current = harness.engine.roles.current;
  for (let step = 0; step < 40 && !current.eosReceived; step += 1) {
    harness.engine.diagnostics.bufferedFrames.current = 0;
    harness.engine.diagnostics.inFlightFrames.current = 0;
    current.encoded.localCreditFrames += 48_000;
    await harness.context.pumpStreamingEncodedRole(current);
    await harness.settle();
  }

  assert.equal(current.eosReceived, true);
  const eos = harness.portMessages('eos').at(-1);
  assert.equal(eos.streamId, open.streamId);
  assert.equal(eos.emittedFrames, 999 * 1_152);
  assert.equal(eos.authoritativeTotalFrames, 999 * 1_152);
  const enqueued = harness.portMessages('enqueue').filter(({ streamId }) => streamId === open.streamId);
  assert.equal(enqueued.reduce((total, { frameCount }) => total + frameCount, 0), 999 * 1_152);
  assert.equal(harness.api.snapshot().duration, duration);
});

test('a lost socket with no seek table waits at the heard position and reopens there on the next socket', async () => {
  const harness = encodedHarness();
  const open = await startEncoded(harness, makeTrack('01.mp3'), { totalFrames: 2_000_000, initialCreditBytes: 4_000 });
  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(1_000)));
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 96_000 });

  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);

  assert.equal(harness.contexts[0].closeCalls, 0);
  const restarted = harness.sockets[1].sent.find(({ type }) => type === 'open');
  assert.equal(restarted.startFrame, 96_000);
  assert.equal(harness.api.snapshot().currentTime, 2);
});

test('a refused socket is an error, not a network change', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  await startLocallySeekable(harness, 100_000);

  harness.sockets[0].unexpectedClose({ code: 4401, reason: 'unauthenticated' });
  await settleTwice(harness);

  assert.equal(harness.sockets.length, 1, 'no reconnect is attempted');
  assert.equal(harness.api.snapshot().mode, 'error');
  assert.equal(harness.api.snapshot().diagnostics.transportDetaches, undefined);
});

test('reconnects keep trying while the received audio plays, and once it runs out the player waits silently at the heard frame', async () => {
  const timers = manualTimers();
  let online = false;
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1 && !online,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 100_000);
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 240_000 });

  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 2, 'the first attempt is immediate');

  const delays = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const [timer] = timers.pending();
    delays.push(timer.delay);
    timers.fire(timer);
    await settleTwice(harness);
  }
  assert.deepEqual(delays, [500, 1_000, 1_000, 1_000, 1_000, 1_000]);
  assert.equal(harness.sockets.length, 8);
  assert.notEqual(harness.api.snapshot().mode, 'error', 'failures stay silent while audio plays');

  harness.nodes[0].port.dispatch({
    type: 'underrun', generation: open.generation, streamId: open.streamId, role: 'current',
    renderedFrame: 1, missingFrames: 128,
  });
  // Losing the network never stops playback, however long.
  assert.deepEqual(timers.pending().map(({ delay }) => delay), [1_000], 'no deadline ends the wait');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    timers.fire(timers.pending()[0]);
    await settleTwice(harness);
  }
  const waiting = harness.api.snapshot();
  assert.equal(waiting.mode, 'buffering');
  assert.equal(waiting.paused, false);
  assert.equal(waiting.currentTime, 5, 'the head stays at the heard frame');
  assert.equal(harness.contexts[0].closeCalls, 0);

  online = true;
  timers.fire(timers.pending()[0]);
  await settleTwice(harness);
  const splice = harness.sockets.at(-1).sent.find(({ type }) => type === 'open');
  assert.equal(splice.startFrame, harness.engine.diagnostics.lastSpliceFrame, 'the rest of the song joins at the splice');
  assert.equal(harness.api.snapshot().paused, false);
});

test('pausing while the network is gone stops the attempts and playing again resumes them', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  assert.equal(timers.pending().length, 1);

  await harness.api.pause();
  assert.equal(timers.pending().length, 0);

  assert.equal(await harness.api.resume(), true);
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 3, 'playing again tries at once');
  assert.equal(harness.api.snapshot().paused, false);
});

test('a socket lost while paused keeps the received audio: Play plays it, and a seek inside it, with no network', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 300_000);
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 96_000 });
  await harness.api.pause();

  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  const paused = harness.api.snapshot();
  assert.equal(paused.diagnostics.transportState, 'detached-splice');
  assert.equal(paused.mode, 'paused');
  assert.equal(harness.sockets.length, 1, 'a paused player tries the network only once played');
  assert.equal(timers.pending().length, 0);

  await harness.api.seek(3);
  await settleTwice(harness);
  assert.equal(harness.engine.roles.continuity.local, true, 'the seek decodes the received audio here');
  assert.equal(harness.api.snapshot().currentTime, 3);
  assert.equal(harness.api.snapshot().paused, true);

  assert.equal(await harness.api.resume(), true);
  await settleTwice(harness);
  const playing = harness.api.snapshot();
  assert.equal(playing.paused, false);
  assert.notEqual(playing.mode, 'error');
  assert.equal(playing.currentTime, 3);
  assert.equal(harness.sockets.length, 2, 'playing tries the network again');
});

test('offline and paused, a seek past the received audio places the head there and stays paused until Play', async () => {
  const timers = manualTimers();
  let online = false;
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1 && !online,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  await harness.api.pause();

  await harness.api.seek(60);
  await settleTwice(harness);
  const placed = harness.api.snapshot();
  assert.equal(placed.currentTime, 60);
  assert.equal(placed.paused, true, 'no sound and no advance');
  assert.notEqual(placed.mode, 'error');
  assert.equal(timers.pending().length, 0, 'nothing is retried while paused');

  online = true;
  assert.equal(await harness.api.resume(), true);
  await settleTwice(harness);
  const opened = harness.sockets.filter(({ readyState }) => readyState === 1);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].sent.filter(({ type }) => type === 'open').map(({ startFrame }) => startFrame), [2_880_000]);
  assert.equal(harness.api.snapshot().currentTime, 60);
  assert.equal(harness.api.snapshot().paused, false);
});

test('offline after a lost socket, a seek moves the waiting place and the song opens there once the network is back', async () => {
  let online = false;
  const timers = manualTimers();
  const harness = encodedHarness({
    refuseConnection: (count) => count > 1 && !online,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startEncoded(harness, makeTrack('01.mp3'), { totalFrames: 2_000_000, initialCreditBytes: 4_000 });
  harness.sockets[0].receive(encodedFrame(open, 0, new Uint8Array(1_000)));
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 96_000 });
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  assert.equal(harness.api.snapshot().currentTime, 2);

  await harness.api.seek(40);
  await settleTwice(harness);
  assert.equal(harness.api.snapshot().currentTime, 40);
  assert.notEqual(harness.api.snapshot().mode, 'error');

  online = true;
  timers.fire(timers.pending().find(({ delay }) => delay <= 2_000));
  await settleTwice(harness);
  const reopened = harness.sockets.at(-1).sent.filter(({ type }) => type === 'open').at(-1);
  assert.equal(reopened.startFrame, 40 * 48_000);
  assert.equal(harness.api.snapshot().paused, false);
});

test('the browser coming back online tries at once', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count === 2,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  const [waiting] = timers.pending();

  harness.dispatchWindowEvent('online');
  await settleTwice(harness);

  assert.equal(waiting.cleared, true);
  assert.equal(harness.sockets.length, 3);
  assert.equal(harness.sockets[2].sent.find(({ type }) => type === 'open').startFrame, 999 * 1_152);
});

test('a socket that stays open but heard nothing for a moment after a network change is replaced', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  await startLocallySeekable(harness, 100_000);

  harness.setNow(1_500);
  harness.dispatchWindowEvent('online');
  assert.equal(harness.sockets[0].closeCalls, 0, 'it was heard a moment ago');

  harness.setNow(5_000);
  harness.dispatchWindowEvent('online');
  await settleTwice(harness);

  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.api.snapshot().diagnostics.transportDetaches, 1);
  assert.equal(harness.sockets[1].sent.find(({ type }) => type === 'open').startFrame, 999 * 1_152);
});

test('offline, a seek inside a song that fully arrived decodes it here', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 173_700);
  receiveOn(harness.sockets[0], open, { type: 'eos', emittedFrames: 2_000_000, authoritativeTotalFrames: 2_000_000 });
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  const opens = harness.sent('open').length;

  await harness.api.seek(30);

  assert.equal(harness.sent('open').length, opens);
  assert.equal(harness.engine.roles.continuity.local, true);
  assert.equal(harness.portMessages('reserve-seek').at(-1).timelineStartFrame, 1_440_000);
});

test('offline, a seek before the splice frame decodes here and still ends at the splice frame', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 150_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  const splice = 1_499 * 1_152;
  const opens = harness.sent('open').length;

  await harness.api.seek(10);

  const local = harness.engine.roles.continuity;
  assert.equal(harness.sent('open').length, opens);
  assert.equal(local.local, true);
  assert.equal(local.startFrame, 480_000);
  assert.equal(local.encoded.eos.authoritativeTotalFrames, splice);
  assert.equal(harness.api.snapshot().diagnostics.lastSpliceFrame, splice);
});

test('offline, a committed seek before the splice frame keeps the splice expected at its frame', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 150_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  await harness.api.seek(10);
  const local = harness.engine.roles.continuity;

  harness.nodes[0].port.dispatch({
    type: 'seek-boundary', generation: open.generation, outgoingStreamId: open.streamId,
    incomingStreamId: local.streamId, renderedFrame: 128, timelineFrame: 480_000, silentFrames: 0,
  });
  await harness.settle();

  assert.equal(harness.engine.roles.current?.streamId, local.streamId);
  const expectation = harness.portMessages('expect-continuity').at(-1);
  assert.deepEqual([expectation.active, expectation.timelineStartFrame], [true, 1_499 * 1_152],
    'the seeked audio still waits for the rest of the track at the splice frame');
});

test('offline, a seek past the received audio jumps at once and plays from there once the network is back', async () => {
  const timers = manualTimers();
  let online = false;
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1 && !online,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);

  await harness.api.seek(60);
  await settleTwice(harness);

  const jumped = harness.api.snapshot();
  assert.equal(jumped.currentTime, 60);
  assert.equal(jumped.paused, false);
  assert.notEqual(jumped.mode, 'error');
  assert.ok(harness.portMessages('configure').at(-1).generation > open.generation, 'the old audio stops at once');
  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.sockets.filter(({ readyState }) => readyState === 1).length, 0, 'offline, no socket opened');

  online = true;
  timers.fire(timers.pending().find(({ delay }) => delay <= 5_000));
  await settleTwice(harness);

  const opened = harness.sockets.filter(({ readyState }) => readyState === 1);
  assert.equal(opened.length, 1);
  const reopened = opened[0].sent.filter(({ type }) => type === 'open');
  assert.deepEqual(reopened.map(({ role, startFrame }) => [role, startFrame]), [['current', 2_880_000]]);
  assert.equal(harness.api.snapshot().currentTime, 60);
  assert.equal(harness.api.snapshot().diagnostics.transportState, 'connected');
});

// CPU at 100%: a click shows its place at once, and the first click moves the head there.
test('offline, a seek past the received audio shows its place and silences the old audio before the slow restart, whose last reports do not move the head', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);

  // Nothing is awaited: on a loaded machine the restart has not run yet.
  const seek = harness.api.seek(60);
  assert.equal(harness.api.snapshot().currentTime, 60, 'the place shows at once');
  assert.ok(harness.portMessages('pause').some(({ generation }) => generation === open.generation),
    'the old audio stops at once');
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 480_000 });
  harness.nodes[0].port.dispatch({
    type: 'consumed', generation: open.generation, streamId: open.streamId,
    role: 'current', frames: 24_000, bufferedFrames: 24_000,
  });
  assert.equal(harness.api.snapshot().currentTime, 60, 'the old audio\'s reports leave the head at the place');

  await seek;
  await settleTwice(harness);
  assert.equal(harness.api.snapshot().currentTime, 60);
  assert.ok(harness.portMessages('configure').at(-1).generation > open.generation);
});

// With Wi-Fi off, the socket stays open and silent, so the
// seek waited on it and the player fell into a paused error at the keepalive.
test('the browser going offline gives up the open socket at once, so a seek past the received audio waits silently at its target', async () => {
  const timers = manualTimers();
  let online = true;
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1 && !online,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 100_000);

  online = false;
  harness.dispatchWindowEvent('offline');
  await settleTwice(harness);
  assert.equal(harness.sockets[0].closeCalls, 1, 'the silent socket is not waited on');
  assert.equal(harness.api.snapshot().diagnostics.transportDetaches, 1);

  await harness.api.seek(60);
  await settleTwice(harness);
  const jumped = harness.api.snapshot();
  assert.equal(jumped.currentTime, 60);
  assert.equal(jumped.paused, false);
  assert.notEqual(jumped.mode, 'error');
  assert.ok(harness.portMessages('configure').at(-1).generation > open.generation, 'the old audio stops at once');

  online = true;
  harness.dispatchWindowEvent('online');
  await settleTwice(harness);
  const opened = harness.sockets.filter(({ readyState }) => readyState === 1);
  assert.equal(opened.length, 1);
  assert.deepEqual(
    opened[0].sent.filter(({ type }) => type === 'open').map(({ role, startFrame }) => [role, startFrame]),
    [['current', 2_880_000]],
  );
  assert.equal(harness.api.snapshot().paused, false);
  assert.equal(harness.api.snapshot().diagnostics.transportState, 'connected');
});

// On a laptop, a click past the received audio stops the music at once, the time moves there and Play
// never pauses by itself. A laptop with another network
// interface never reports `offline`: the socket stays open and silent.
test('a seek the open socket does not begin to answer jumps to its target silently and keeps playing, with no offline event', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 100_000);

  harness.setNow(1_000);
  await harness.api.seek(60);
  await settleTwice(harness);
  assert.ok(harness.engine.pendingSeek, 'past the received audio, the seek asks the server');
  harness.setNow(1_500);
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 100 });
  assert.equal(harness.sockets[0].closeCalls, 0, 'an answer may still be on its way');

  harness.setNow(1_800);
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 200 });
  await settleTwice(harness);

  assert.equal(harness.sockets[0].closeCalls, 1, 'the unanswering socket is given up');
  const held = harness.api.snapshot();
  assert.equal(held.currentTime, 60);
  assert.equal(held.paused, false, 'the player stays playing, silent at its target');
  assert.notEqual(held.mode, 'error');
  assert.equal(held.diagnostics.transportState, 'detached-seek');
  assert.ok(harness.portMessages('configure').at(-1).generation > open.generation, 'the old audio stops at once');
  assert.ok(harness.portMessages('pause').some(({ generation }) => generation === open.generation),
    'the old audio is silenced before the jump reconfigures the worklet');
  assert.equal(harness.portMessages('play').at(-1).generation, harness.portMessages('configure').at(-1).generation,
    'the jump plays on at its target');
});

test('a socket that hears nothing, not even a heartbeat, is given up while the received audio plays, with no network event', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  const open = await startLocallySeekable(harness, 100_000);

  harness.setNow(5_000);
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 100 });
  assert.equal(harness.sockets[0].closeCalls, 0, 'heard a few seconds ago, as a slow network delivers');

  harness.setNow(6_500);
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 200 });
  await settleTwice(harness);

  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.api.snapshot().diagnostics.transportDetaches, 1);
  assert.equal(harness.api.snapshot().paused, false);
  assert.equal(harness.sockets[1].sent.find(({ type }) => type === 'open').startFrame, 999 * 1_152, 'the rest joins at the splice');
});

// One press starts another song after the network is back. A start or a song's rate asked of a socket that died
// without closing is never answered: the socket, which hears not even the server's heartbeat, is
// replaced, and what waited on it goes again on the new one, so one press starts the song.
test('paused, a start asked of a socket that hears nothing goes again on a new socket, with no second press', async () => {
  const harness = encodedHarness();
  await startEncoded(harness, makeTrack('01.mp3'));
  await harness.api.pause();
  await harness.settle();

  void harness.api.start(makeTrack('02.mp3'));
  await settleTwice(harness);
  void harness.api.start(makeTrack('03.mp3'));
  await settleTwice(harness);
  checkLivenessUntil(harness, 1_500, 5_500);
  assert.equal(harness.sockets[0].closeCalls, 0, 'heard a few seconds ago: a busy server is not a dead one');
  checkLivenessUntil(harness, 6_000, 6_500);
  await settleTwice(harness);
  await settleTwice(harness);

  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.equal(harness.sockets[1].sent.filter(({ type }) => type === 'open').at(-1)?.path, makeTrack('03.mp3').path,
    'the last press goes on the new socket');
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

// With the CPU at 100%, another track, even on the same album, sometimes took up to 10 s to start.
// A loaded server fell silent for about a second while a switch waited on its
// open; the socket was given up after 750 ms, and the new socket's connect and open took 4-17 s more.
// The old song still plays through a switch, so its socket gets the patience of any silent socket.
test('a switch whose open a busy server leaves unanswered for a moment keeps its socket', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  const outgoing = await startLocallySeekable(harness, 400_000);
  harness.setNow(1_000);
  void harness.api.start(makeTrack('02.mp3'));
  await settleTwice(harness);
  const replacement = harness.sockets[0].sent.filter(({ type }) => type === 'open').at(-1);
  assert.equal(replacement.path, makeTrack('02.mp3').path);
  assert.equal(harness.engine.pendingSeek?.kind, 'replacement', 'the switch crosses over from the playing song');

  for (let now = 1_500; now <= 5_500; now += 500) {
    harness.setNow(now);
    harness.nodes[0].port.dispatch({
      type: 'position', generation: outgoing.generation, streamId: outgoing.streamId, timelineFrame: now,
    });
    liveness(harness).callback();
  }
  await settleTwice(harness);
  assert.equal(harness.sockets[0].closeCalls, 0, 'a server silent for seconds is busy, not gone');
  assert.equal(harness.sockets.length, 1);

  checkLivenessUntil(harness, 6_000, 6_500);
  await settleTwice(harness);
  assert.equal(harness.sockets[0].closeCalls, 1, 'a socket silent for longer is still given up');
});

test('a busy server that only beats its heart is waited on, however long it takes to answer', async () => {
  const harness = encodedHarness();
  await startEncoded(harness, makeTrack('01.mp3'));
  await harness.api.pause();
  await harness.settle();

  void harness.api.start(makeTrack('02.mp3'));
  await settleTwice(harness);
  for (let now = 1_500; now <= 30_000; now += 500) {
    harness.setNow(now);
    harness.sockets[0].receive({ type: 'heartbeat' });
    liveness(harness).callback();
  }
  assert.equal(harness.sockets[0].closeCalls, 0);
  assert.equal(harness.sockets.length, 1);
});

test('a liveness check that ran late, on a page too busy to read what arrived, decides nothing', async () => {
  const harness = encodedHarness();
  await startEncoded(harness, makeTrack('01.mp3'));
  harness.setNow(9_000);
  liveness(harness).callback();
  assert.equal(harness.sockets[0].closeCalls, 0, 'the heartbeats may be waiting to be read');
  harness.setNow(9_500);
  liveness(harness).callback();
  assert.equal(harness.sockets[0].closeCalls, 1, 'on time, the silence counts');
});

// Hosted FTC-PLAYBACK-OFFLINE-002: paused through the outage, one press on another song
// asked a dead socket for that song's rate and waited forever.
test('a rate probe asked of a socket that hears nothing goes again on a new socket, so one press starts the song', async () => {
  const harness = encodedHarness({ holdSampleRateProbes: true, trackSampleRates: new Map() });
  // A 320 kbps stream still asks for its rate before it opens.
  harness.engine.qualityPreference = '320';
  const first = harness.api.start(makeTrack('01.flac'));
  for (let turn = 0; turn < 20 && !harness.sockets[0]?.probes.length; turn += 1) await harness.settle();
  harness.sockets[0].receive({ type: 'probe-result', requestId: harness.sockets[0].probes[0].requestId, sampleRate: 48_000 });
  await first;
  acceptMetadata(harness, harness.sent('open').at(-1), { codec: 'mp3', skipFrames: 1_105, totalFrames: 2_000 });
  await harness.settle();
  await harness.api.pause();
  await harness.settle();

  void harness.api.start(makeTrack('02.flac'));
  await settleTwice(harness);
  assert.equal(harness.sockets[0].probes.at(-1)?.path, makeTrack('02.flac').path, 'the new song asks for its rate');
  checkLivenessUntil(harness, 1_500, 6_500);
  await settleTwice(harness);

  assert.equal(harness.sockets[0].closeCalls, 1, 'the silent socket is replaced');
  const again = harness.sockets[1].probes.at(-1);
  assert.equal(again?.path, makeTrack('02.flac').path, 'the probe goes again on the new socket');
  harness.sockets[1].receive({ type: 'probe-result', requestId: again.requestId, sampleRate: 48_000 });
  await settleTwice(harness);
  await settleTwice(harness);
  assert.equal(harness.sockets[1].sent.filter(({ type }) => type === 'open').at(-1)?.path, makeTrack('02.flac').path);
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

test('a guessed-rate start asked of a socket that hears nothing opens the song on a new socket, so one press starts it', async () => {
  const harness = encodedHarness({ ...PLAYED_AT_44_100, trackSampleRates: new Map() });
  await harness.api.start(makeTrack('01.mp3'));
  acceptMetadata(harness, harness.sent('open').at(-1), {
    sampleRate: 44_100, codec: 'mp3', skipFrames: 1_105, totalFrames: 2_000,
  });
  await harness.settle();
  await harness.api.pause();
  await harness.settle();

  void harness.api.start(makeTrack('02.mp3'));
  await settleTwice(harness);
  const guessed = harness.sockets[0].sent.filter(({ type }) => type === 'open').at(-1);
  assert.equal(guessed?.path, makeTrack('02.mp3').path, 'the new song opens at once, with no probe');
  assert.equal(harness.sockets[0].probes.length, 0);
  checkLivenessUntil(harness, 1_500, 6_500);
  await settleTwice(harness);

  assert.equal(harness.sockets[0].closeCalls, 1, 'the silent socket is replaced');
  await settleTwice(harness);
  await settleTwice(harness);
  const reopened = harness.sockets[1].sent.filter(({ type }) => type === 'open').at(-1);
  assert.equal(reopened?.path, makeTrack('02.mp3').path, 'the song opens again on the new socket');
  assert.equal(reopened.sampleRate, 44_100);
  assert.notEqual(reopened.streamId, guessed.streamId, 'a fresh stream, never one named on the old socket');
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

// Hosted FTC-PLAYBACK-OFFLINE-001: back online, a seek past the received audio waited on a socket
// that fell silent while another song's rate was still asked. The new socket asked that rate again,
// but the seek's open never went on it, and the head waited at its place for ever.
test('a seek whose silent socket is replaced while another song\'s rate is still asked opens at its place on the new socket, once', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    holdSampleRateProbes: true,
    trackSampleRates: new Map([[makeTrack('01.mp3').path, 48_000]]),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 100_000);
  void harness.context.requestStreamingSampleRate(makeTrack('02.mp3'));
  await harness.settle();
  assert.equal(harness.sockets[0].probes.at(-1)?.path, makeTrack('02.mp3').path, 'the next song asks its rate');

  harness.setNow(1_000);
  await harness.api.seek(60);
  await settleTwice(harness);
  assert.ok(harness.engine.pendingSeek, 'past the received audio, the seek asks the server');
  harness.setNow(1_800);
  harness.nodes[0].port.dispatch({ type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 200 });
  await settleTwice(harness);
  await settleTwice(harness);
  await settleTwice(harness);

  assert.equal(harness.sockets[0].closeCalls, 1, 'the silent socket is replaced');
  assert.equal(harness.sockets.length, 2);
  assert.deepEqual(
    harness.sockets[1].sent.filter(({ type }) => type === 'open').map(({ path, startFrame }) => [path, startFrame]),
    [[makeTrack('01.mp3').path, 2_880_000]],
    'one open, at the seek\'s place, on the new socket',
  );
  assert.equal(harness.sockets[1].probes.at(-1)?.path, makeTrack('02.mp3').path, 'the rate is asked again too');
  assert.equal(harness.api.snapshot().currentTime, 60);
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

test('a start whose silent socket is replaced while another song\'s rate is still asked opens on the new socket, once', async () => {
  const harness = encodedHarness({
    holdSampleRateProbes: true,
    trackSampleRates: new Map([[makeTrack('01.mp3').path, 48_000], [makeTrack('02.mp3').path, 48_000]]),
  });
  await startEncoded(harness, makeTrack('01.mp3'));
  await harness.api.pause();
  await harness.settle();
  void harness.context.requestStreamingSampleRate(makeTrack('03.mp3'));
  await harness.settle();

  void harness.api.start(makeTrack('02.mp3'));
  await settleTwice(harness);
  const first = harness.sockets[0].sent.filter(({ type }) => type === 'open').at(-1);
  assert.equal(first?.path, makeTrack('02.mp3').path, 'the press opens its song');
  checkLivenessUntil(harness, 1_500, 6_500);
  await settleTwice(harness);
  await settleTwice(harness);
  await settleTwice(harness);

  assert.equal(harness.sockets[0].closeCalls, 1, 'the silent socket is replaced');
  const opens = harness.sockets[1].sent.filter(({ type }) => type === 'open');
  assert.deepEqual(opens.map(({ path }) => path), [makeTrack('02.mp3').path], 'one open of the pressed song on the new socket');
  assert.notEqual(opens[0].streamId, first.streamId, 'a fresh stream, never one named on the old socket');
  assert.equal(harness.sockets[1].probes.at(-1)?.path, makeTrack('03.mp3').path, 'the rate is asked again too');
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

// A press whose song's rate is still asked is already switching to that song: the engine says which,
// as it does once the switch waits for its audio, so a second press during it is seen as one.
test('a press still asking its song\'s rate names the song it switches to', async () => {
  const harness = encodedHarness({ holdSampleRateProbes: true, trackSampleRates: new Map() });
  // A 320 kbps stream of a song not played before asks for its rate before it opens.
  harness.engine.qualityPreference = '320';
  const first = harness.api.start(makeTrack('01.flac'));
  for (let turn = 0; turn < 20 && !harness.sockets[0]?.probes.length; turn += 1) await harness.settle();
  harness.sockets[0].receive({ type: 'probe-result', requestId: harness.sockets[0].probes[0].requestId, sampleRate: 48_000 });
  await first;
  acceptMetadata(harness, harness.sent('open').at(-1), { codec: 'mp3', skipFrames: 1_105, totalFrames: 2_000 });
  await harness.settle();
  const switchingTo = () => harness.context.streamingEngineState().pendingStart?.track?.path;
  const opened = (name) => harness.sockets[0].sent.some(({ type, path }) => type === 'open' && path === makeTrack(name).path);

  void harness.api.start(makeTrack('02.flac'));
  await settleTwice(harness);
  assert.equal(harness.sockets[0].probes.at(-1)?.path, makeTrack('02.flac').path, 'its rate is asked');
  assert.equal(opened('02.flac'), false, 'nothing is opened before the rate is known');
  assert.equal(switchingTo(), makeTrack('02.flac').path, 'the press names its song while the rate is asked');

  void harness.api.start(makeTrack('03.flac'));
  await settleTwice(harness);
  assert.equal(harness.sockets[0].probes.at(-1)?.path, makeTrack('03.flac').path);
  assert.equal(opened('03.flac'), false);
  assert.equal(switchingTo(), makeTrack('03.flac').path, 'a later press takes over');
});

// Hosted FTC-PLAYBACK-OFFLINE-002, 2ecca92bb's parent: paused, the socket closed while a press on
// another song was on its way, and for 60 s no socket and no open followed.
for (const [received, kind] of [[100_000, 'whose received audio can be spliced'], [0, 'with no audio received']]) {
  test(`a paused player ${kind} whose socket closes while a press is on its way opens the pressed song on one new socket`, async () => {
    const harness = encodedHarness();
    await startLocallySeekable(harness, received);
    await harness.api.pause();
    await harness.settle();
    // The press waits on the browser's cache of kept songs while the socket closes.
    let answerCache;
    Object.assign(harness.context, {
      streamingTrackCacheKey: (track, quality) => `${track.path}|${quality || 'original'}`,
      loadStreamingCachedTrack: () => new Promise((resolve) => { answerCache = resolve; }),
      keepStreamingCachedTrack: () => {},
    });

    const press = harness.api.start(makeTrack('02.mp3'));
    await harness.settle();
    assert.equal(typeof answerCache, 'function', 'the press is on its way');
    harness.sockets[0].unexpectedClose();
    await settleTwice(harness);
    answerCache(null);
    await settleTwice(harness);
    await settleTwice(harness);

    assert.equal(harness.sockets.length, 2, 'one new socket');
    const opens = harness.sockets[1].sent.filter(({ type }) => type === 'open');
    assert.deepEqual(opens.map(({ path }) => path), [makeTrack('02.mp3').path], 'one open, of the pressed song');
    assert.notEqual(harness.api.snapshot().mode, 'error');
    void press;
  });
}

test('the browser going offline also gives up a reconnect socket still waiting to join the splice', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  const first = harness.sockets[1].sent.find(({ type }) => type === 'open');

  harness.dispatchWindowEvent('offline');
  await settleTwice(harness);

  assert.equal(harness.sockets[1].closeCalls, 1);
  assert.equal(harness.api.snapshot().diagnostics.transportDetaches, 1, 'still the one outage');
  assert.notEqual(harness.api.snapshot().mode, 'error');
  assert.equal(harness.sockets[2].sent.find(({ type }) => type === 'open').startFrame, first.startFrame);
});

test('losing the next socket before the splice joined opens the splice again on the one after', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  const first = harness.sockets[1].sent.find(({ type }) => type === 'open');
  const sentOnSecond = harness.sockets[1].sent.length;

  harness.sockets[1].unexpectedClose();
  assert.equal(harness.engine.roles.continuity?.streamId ?? null, null);
  await settleTwice(harness);

  assert.equal(harness.sockets[1].sent.length, sentOnSecond);
  const again = harness.sockets[2].sent.find(({ type }) => type === 'open');
  assert.equal(again.startFrame, first.startFrame);
  assert.ok(again.streamId > first.streamId);
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

test('a reconnect attempt that hangs is given up after a few seconds and the next one is made', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => (count === 2 ? 'hang' : false),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  assert.equal(harness.sockets.length, 2);
  assert.equal(harness.sockets[1].readyState, 0, 'the attempt hangs');

  const deadline = timers.pending().find(({ delay }) => delay === 4_000);
  assert.ok(deadline, 'the hanging attempt has a deadline');
  timers.fire(deadline);
  await settleTwice(harness);
  assert.equal(harness.sockets[1].closeCalls, 1);

  timers.fire(timers.pending().find(({ delay }) => delay === 500));
  await settleTwice(harness);

  assert.equal(harness.sockets.length, 3);
  assert.equal(harness.sockets[2].sent.find(({ type }) => type === 'open').startFrame, 999 * 1_152);
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

// CPU at 100%: playback goes on when the network is back. On a loaded machine a connection can take longer than the deadline to open.
test('each reconnect attempt cut off by its deadline allows the next one twice as long, up to 16 s', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => (count > 1 ? 'hang' : false),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);

  const deadlines = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const deadline = timers.pending().find(({ delay }) => delay >= 4_000);
    deadlines.push(deadline.delay);
    timers.fire(deadline);
    await settleTwice(harness);
    timers.fire(timers.pending().find(({ delay }) => delay <= 2_000));
    await settleTwice(harness);
  }

  assert.deepEqual(deadlines, [4_000, 8_000, 16_000, 16_000]);
  assert.notEqual(harness.api.snapshot().mode, 'error');
});

test('a network change during a hanging reconnect replaces it at once', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => (count === 2 ? 'hang' : false),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);

  harness.dispatchWindowEvent('online');
  await settleTwice(harness);

  assert.equal(harness.sockets[1].closeCalls, 1);
  assert.equal(harness.sockets.length, 3);
  assert.equal(harness.sockets[2].sent.find(({ type }) => type === 'open').startFrame, 999 * 1_152);
  assert.equal(timers.pending().filter(({ delay }) => delay <= 5_000).length, 0, 'no attempt is left waiting');
});

test('a successor that fully arrived stays prepared through a network change and needs no new stream', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  const open = await startLocallySeekable(harness, 173_700);
  receiveOn(harness.sockets[0], open, { type: 'eos', emittedFrames: 2_000_000, authoritativeTotalFrames: 2_000_000 });
  harness.engine.diagnostics.bufferedFrames.current = 48_000;
  await harness.api.continuity(makeTrack('02.mp3'));
  await harness.settle();
  const next = harness.sent('open').at(-1);
  acceptEncodedMetadata(harness.sockets[0], next, { totalFrames: 20_000, provisionalTotalFrames: 20_000, initialCreditBytes: 2_000 });
  harness.sockets[0].receive(encodedFrame(next, 0, new Uint8Array(2_000)));
  receiveOn(harness.sockets[0], next, { type: 'eos', emittedFrames: 20_000, authoritativeTotalFrames: 20_000 });
  await harness.settle();
  const releases = harness.portMessages('drop-continuity').length;

  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  await settleTwice(harness);

  assert.equal(harness.engine.roles.continuity?.streamId, next.streamId, 'the successor stays');
  assert.equal(harness.engine.roles.continuity.local, true);
  assert.equal(harness.portMessages('drop-continuity').length, releases);
  assert.equal(harness.sockets[1].sent.filter(({ type }) => type === 'open').length, 0, 'nothing is reopened');
  assert.equal(harness.api.snapshot().diagnostics.transportState, 'connected');
});

test('pausing while a splice is pending keeps it: playing again joins the rest of the song at the same frame', async () => {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count === 2,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  await harness.api.pause();
  assert.equal(timers.pending().length, 0, 'a paused player makes no attempt');

  assert.equal(await harness.api.resume(), true);
  await settleTwice(harness);

  const splice = harness.sockets[2].sent.find(({ type }) => type === 'open');
  assert.equal(splice.startFrame, 999 * 1_152);
  assert.equal(harness.api.snapshot().diagnostics.lastSpliceFrame, 999 * 1_152);
  const expectation = harness.portMessages('expect-continuity').at(-1);
  assert.deepEqual([expectation.active, expectation.timelineStartFrame], [true, 999 * 1_152]);
});

test('a seek once the next socket is open, before the splice joined, asks the server and counts no resume', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  await startLocallySeekable(harness, 100_000);
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  const splice = harness.sockets[1].sent.find(({ type }) => type === 'open');

  await harness.api.seek(10);

  const seekOpen = harness.sockets[1].sent.filter(({ type }) => type === 'open').at(-1);
  assert.deepEqual([seekOpen.role, seekOpen.startFrame], ['continuity', 480_000]);
  assert.ok(harness.sockets[1].sent.some(({ type, streamId }) => type === 'close' && streamId === splice.streamId));
  const snapshot = harness.api.snapshot();
  assert.equal(snapshot.diagnostics.transportState, 'connected');
  assert.equal(snapshot.diagnostics.transportResumes, undefined);
});

// The new song starts at once, and the old song sounds until it does.
// These render the real worklet: each song is a level, so a quantum says which one is heard.
const OLD_SONG = 0.25;
const NEXT_SONG = 0.75;
const PRESSED_SONG = 0.5;
const ONE_SECOND = 48_000;

function heard(node) {
  const left = node.render()[0];
  return left.every((sample) => sample === left[0]) ? left[0] : 'mixed';
}

function heardFor(node, quanta) {
  const levels = new Set();
  for (let index = 0; index < quanta; index += 1) {
    levels.add(heard(node));
    node.deliverEvents();
  }
  return [...levels];
}

function receiveSong(
  harness, open, level, frames, sequence = 0, role = open.role === 'current' ? 0 : 1, expectations = {},
) {
  for (let sent = 0; sent < frames; sent += ONE_SECOND) {
    receivePcmAndAssertEnqueue(harness, {
      role,
      generation: open.generation,
      streamId: open.streamId,
      sequence: sequence + sent / ONE_SECOND,
      samples: new Array(Math.min(ONE_SECOND, frames - sent) * 2).fill(level),
    }, {
      socket: harness.sockets.at(-1),
      // A cut-over stream keeps its wire role and plays as the current one.
      role: harness.engine.roles.current?.streamId === open.streamId ? 'current' : 'continuity',
      ...expectations,
    });
  }
}

async function playingSong(t, options = {}) {
  const harness = createEngineHarness({ realProcessor: true, ...options });
  t.after(() => harness.api.stop());
  await harness.api.start(makeTrack('01.flac'));
  const open = harness.sent('open')[0];
  acceptMetadata(harness, open);
  receiveSong(harness, open, OLD_SONG, 2 * ONE_SECOND);
  await harness.settle();
  const node = harness.nodes[0];
  assert.deepEqual(heardFor(node, 1), [OLD_SONG]);
  return { harness, node, open };
}

async function pressTrack(harness, name) {
  const outcome = {};
  outcome.done = Promise.resolve(harness.api.start(makeTrack(name))).then(
    (role) => { outcome.role = role; },
    (error) => { outcome.error = error; },
  );
  await harness.settle();
  outcome.open = harness.sent('open').filter(({ path }) => path === makeTrack(name).path).at(-1);
  return outcome;
}

async function answerOpen(harness, open, level, frames = 2 * ONE_SECOND, expectations = {}) {
  acceptMetadata(harness, open);
  receiveSong(harness, open, level, frames, 0, 1, expectations);
  await harness.settle();
}

test('a press with under a second of the playing song left keeps it sounding until the new song starts', async (t) => {
  const { harness, node } = await playingSong(t);
  heardFor(node, 384);
  assert.ok(harness.engine.diagnostics.bufferedFrames.current < ONE_SECOND);

  const pressed = await pressTrack(harness, '05.flac');

  assert.deepEqual(heardFor(node, 20), [OLD_SONG], 'the press does not silence the playing song');
  assert.equal(pressed.open.role, 'continuity');
  await answerOpen(harness, pressed.open, PRESSED_SONG);
  assert.deepEqual(heardFor(node, 4), [PRESSED_SONG], 'the short cushion never defers the new song');
});

test('a press while a switch waits retargets it, and the playing song sounds until the last pressed one starts', async (t) => {
  const { harness, node } = await playingSong(t);
  const first = await pressTrack(harness, '05.flac');
  acceptMetadata(harness, first.open);
  receiveSong(harness, first.open, NEXT_SONG, 4_800, 0, 1);
  await harness.settle();

  const last = await pressTrack(harness, '06.flac');

  assert.deepEqual(heardFor(node, 20), [OLD_SONG], 'a second press does not silence the playing song');
  await first.done;
  assert.match(first.error.message, /superseded/);
  assert.ok(harness.sent('close').some(({ streamId }) => streamId === first.open.streamId));
  assert.equal(last.open.role, 'continuity');
  await answerOpen(harness, last.open, PRESSED_SONG);
  assert.deepEqual(heardFor(node, 4), [PRESSED_SONG]);
  await last.done;
  assert.equal(last.role.streamId, last.open.streamId);
  assert.equal(harness.engine.diagnostics.lastProcessorReject, undefined);
});

for (const committed of [false, true]) {
  test(`a press as a switch cuts over keeps audio playing (${committed ? 'already rendered' : 'not yet rendered'})`, async (t) => {
    const { harness, node } = await playingSong(t);
    const first = await pressTrack(harness, '05.flac');
    await answerOpen(harness, first.open, NEXT_SONG);
    assert.equal(harness.engine.pendingSeek.prepareSent, true);
    if (committed) assert.equal(heard(node), NEXT_SONG);

    const last = await pressTrack(harness, '06.flac');
    assert.equal(heard(node), NEXT_SONG, 'the cut-over already handed to the worklet completes');
    node.deliverEvents();
    await harness.settle();

    assert.deepEqual(heardFor(node, 20), [NEXT_SONG]);
    const open = harness.sent('open').at(-1);
    assert.equal(open.path, makeTrack('06.flac').path);
    assert.equal(open.role, 'continuity');
    await answerOpen(harness, open, PRESSED_SONG);
    assert.deepEqual(heardFor(node, 4), [PRESSED_SONG]);
    await last.done;
    assert.equal(last.role.streamId, open.streamId);
  });
}

for (const prepared of [false, true]) {
  test(`a press while a seek ${prepared ? 'cuts over' : 'waits'} keeps audio playing`, async (t) => {
    const { harness, node } = await playingSong(t);
    await harness.api.seek(120);
    const seek = harness.sent('open').at(-1);
    if (prepared) await answerOpen(harness, seek, NEXT_SONG, 12_000);

    await pressTrack(harness, '06.flac');
    if (prepared) {
      node.render();
      node.deliverEvents();
      await harness.settle();
      // A seek keeps its own cushion; once that is in, its audio is what the press must keep.
      receiveSong(harness, seek, NEXT_SONG, ONE_SECOND, 1, 1);
      receiveSong(harness, seek, NEXT_SONG, 36_000, 2, 1);
      await harness.settle();
    }

    assert.deepEqual(heardFor(node, 20), [prepared ? NEXT_SONG : OLD_SONG]);
    const open = harness.sent('open').at(-1);
    assert.equal(open.path, makeTrack('06.flac').path);
    assert.equal(open.role, 'continuity');
    await answerOpen(harness, open, PRESSED_SONG);
    assert.deepEqual(heardFor(node, 4), [PRESSED_SONG]);
  });
}

async function playingWithPreparedNext(t, options = {}) {
  const playing = await playingSong(t, options);
  const { harness } = playing;
  await harness.api.continuity(makeTrack('02.flac'), {
    kind: 'queued-next', startSeconds: 0, consecutiveAlbumBoundary: true,
  });
  const next = harness.sent('open').at(-1);
  await answerOpen(harness, next, NEXT_SONG);
  return { ...playing, next };
}

test('a press just after a gapless track change, before the server acknowledged it, keeps that track sounding', async (t) => {
  const { harness, node, open } = await playingWithPreparedNext(t);
  harness.sockets[0].receive({
    type: 'eos', generation: open.generation, streamId: open.streamId, role: 'current',
    emittedFrames: 2 * ONE_SECOND, authoritativeTotalFrames: 2 * ONE_SECOND,
  });
  await harness.settle();
  while (harness.engine.roles.current.streamId === open.streamId) {
    node.render();
    node.deliverEvents();
  }
  assert.ok(harness.engine.pendingPromotion);

  const pressed = await pressTrack(harness, '07.flac');

  assert.deepEqual(heardFor(node, 20), [NEXT_SONG]);
  assert.equal(pressed.open.role, 'continuity');
});

test('a press with nothing of the playing song left starts the new song as a fresh stream', async (t) => {
  const { harness, node } = await playingSong(t);
  heardFor(node, 752);
  assert.equal(harness.engine.diagnostics.bufferedFrames.current, 0);

  const pressed = await pressTrack(harness, '05.flac');

  assert.equal(pressed.open.role, 'current', 'with no audio to keep, nothing waits for a cross-over');
});

function answerAuthority(harness, probe) {
  harness.sockets.at(-1).receive({ type: 'probe-result', requestId: probe.requestId });
}

async function pressPreparedNext(t) {
  const playing = await playingWithPreparedNext(t, { holdSampleRateProbes: true });
  const { harness } = playing;
  const opens = harness.sent('open').length;
  const pressed = await pressTrack(harness, '02.flac');
  return { ...playing, pressed, opens, probe: harness.sockets[0].probes.at(-1) };
}

test('a press on the prepared next track cuts over to its decoded frames once the press refresh answers', async (t) => {
  const { harness, node, next, pressed, opens, probe } = await pressPreparedNext(t);

  assert.equal(harness.sent('open').length, opens, 'the decoded track is not opened again');
  assert.equal(harness.sent('close').some(({ streamId }) => streamId === next.streamId), false);
  assert.deepEqual(
    { path: probe?.path, authorityOnly: probe?.authorityOnly },
    { path: makeTrack('02.flac').path, authorityOnly: true },
  );
  // 600 ms of a slow refresh is 225 render quanta.
  assert.deepEqual(heardFor(node, 225), [OLD_SONG], 'nothing of the new song sounds before the refresh');

  answerAuthority(harness, probe);
  await harness.settle();

  assert.equal(heard(node), NEXT_SONG, 'the first quantum after the answer is the new song');
  node.deliverEvents();
  await pressed.done;
  assert.equal(pressed.role.streamId, next.streamId);
  assert.ok(harness.sent('promote').some(({ streamId }) => streamId === next.streamId));
  assert.equal(harness.api.snapshot().src, makeTrack('02.flac').src);
  assert.equal(harness.api.snapshot().paused, false);
  assert.equal(harness.portMessages('configure').length, 1);
});

test('a pressed next track still filling cuts over when refreshed and filled, not before', async (t) => {
  const { harness, node } = await playingSong(t, { holdSampleRateProbes: true });
  await harness.api.continuity(makeTrack('02.flac'), { kind: 'queued-next', startSeconds: 0 });
  const next = harness.sent('open').at(-1);
  acceptMetadata(harness, next);
  receiveSong(harness, next, NEXT_SONG, 4_800, 0, 1);
  await pressTrack(harness, '02.flac');
  answerAuthority(harness, harness.sockets[0].probes.at(-1));
  await harness.settle();
  assert.deepEqual(heardFor(node, 4), [OLD_SONG]);

  receiveSong(harness, next, NEXT_SONG, 43_200, 1, 1);
  receiveSong(harness, next, NEXT_SONG, ONE_SECOND, 2, 1);
  await harness.settle();

  assert.deepEqual(heardFor(node, 4), [NEXT_SONG]);
});

test('the prepared next track never follows the old song to its end before the press refresh answers', async (t) => {
  const { harness, node, open, probe } = await pressPreparedNext(t);
  harness.sockets[0].receive({
    type: 'eos', generation: open.generation, streamId: open.streamId, role: 'current',
    emittedFrames: 2 * ONE_SECOND, authoritativeTotalFrames: 2 * ONE_SECOND,
  });
  await harness.settle();

  const levels = heardFor(node, 800);

  assert.equal(levels.includes(NEXT_SONG), false);
  answerAuthority(harness, probe);
  await harness.settle();
  assert.deepEqual(heardFor(node, 4), [NEXT_SONG]);
});

for (const code of [4401, 4403, 1006]) {
  test(`the prepared next track never sounds when the press refresh ends in ${code}`, async (t) => {
    const { harness, node } = await pressPreparedNext(t);

    harness.sockets[0].unexpectedClose({ code });
    await harness.settle();

    assert.equal(heardFor(node, 800).includes(NEXT_SONG), false);
    if (code === 1006) {
      assert.equal(harness.sent('open').at(-1).path, makeTrack('02.flac').path,
        'on the next socket the press is an ordinary open, with its own refresh');
    }
  });
}

test('a press elsewhere while the refresh waits leaves the prepared track silent, late answer or not', async (t) => {
  const { harness, node, probe } = await pressPreparedNext(t);
  const last = await pressTrack(harness, '06.flac');

  answerAuthority(harness, probe);
  await harness.settle();

  assert.deepEqual(heardFor(node, 20), [OLD_SONG]);
  await answerOpen(harness, last.open, PRESSED_SONG);
  assert.deepEqual(heardFor(node, 4), [PRESSED_SONG]);
});

test('a prepared track dropped while the refresh waits opens again instead of hanging the press', async (t) => {
  const { harness, node, probe } = await pressPreparedNext(t);
  harness.context.closeStreamingContinuityRole('decoder-fallback');

  answerAuthority(harness, probe);
  await harness.settle();

  const reopened = harness.sent('open').at(-1);
  assert.equal(reopened.path, makeTrack('02.flac').path);
  assert.equal(reopened.role, 'continuity');
  assert.deepEqual(heardFor(node, 4), [OLD_SONG]);
});

test('a press into the prepared track at another place opens it there', async (t) => {
  const { harness } = await playingWithPreparedNext(t);

  void harness.api.start(makeTrack('02.flac'), { startSeconds: 30 }).catch(() => {});
  await harness.settle();

  assert.equal(harness.sent('open').at(-1).startFrame, 30 * ONE_SECOND);
});

test('a prepared compressed track needs its usual one second of head, after the refresh', async (t) => {
  const harness = encodedHarness({ holdSampleRateProbes: true });
  t.after(() => harness.api.stop());
  await harness.api.start(makeTrack('01.flac'));
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  receivePcmAndAssertEnqueue(harness, {
    generation: current.generation, streamId: current.streamId, samples: new Array(ONE_SECOND * 2).fill(OLD_SONG),
  });
  harness.nodes[0].port.dispatch({
    type: 'first-frame', generation: current.generation, streamId: current.streamId, renderedFrame: 0,
  });
  await harness.api.continuity(makeTrack('02.mp3'), { kind: 'queued-next', startSeconds: 0 });
  const next = harness.sent('open').at(-1);
  acceptMetadata(harness, next, { codec: 'mp3', skipFrames: 0, totalFrames: 2_000_000 });
  await harness.settle();
  // 42 packets of 1152 frames are just over a second.
  for (let sequence = 0; sequence < 42; sequence += 1) {
    harness.sockets[0].receive(encodedFrame(next, sequence, new Uint8Array(100)));
    await harness.settle();
  }
  void harness.api.start(makeTrack('02.mp3')).catch(() => {});
  await harness.settle();
  assert.equal(harness.portMessages('prepare-seek').length, 0);

  answerAuthority(harness, harness.sockets[0].probes.at(-1));
  await harness.settle();

  assert.equal(harness.portMessages('prepare-seek').at(-1)?.streamId, next.streamId);
});

for (const waiting of ['open', 'retargeted open', 'refresh', 'cut-over']) {
  test(`a handover pause goes silent at once while a switch waits on its ${waiting}`, async (t) => {
    const { harness, node, probe } = waiting === 'refresh'
      ? await pressPreparedNext(t)
      : await playingSong(t);
    let pending = null;
    if (waiting !== 'refresh') pending = await pressTrack(harness, '05.flac');
    if (waiting === 'retargeted open') pending = await pressTrack(harness, '06.flac');
    if (waiting === 'cut-over') await answerOpen(harness, pending.open, PRESSED_SONG);

    await harness.api.pause();
    assert.deepEqual(heardFor(node, 20), [0], 'the handover silences the old song on purpose');

    if (waiting === 'refresh') answerAuthority(harness, probe);
    else if (waiting !== 'cut-over') {
      await answerOpen(harness, pending.open, PRESSED_SONG, 2 * ONE_SECOND, { expectedEnqueue: false });
    }
    await harness.settle();
    assert.deepEqual(heardFor(node, 20), [0], 'a late answer never sounds the pressed song');
    assert.equal(harness.api.snapshot().paused, true);
  });
}

// A press as the player makes it: its failure reaches failStreamingEngine, which ends playback.
function pressInPlayer(harness, name) {
  const { context } = harness;
  if (typeof context.playTrackFromPayload !== 'function') {
    loadLeaseRecoveryRuntime(harness);
    Object.assign(context, {
      canStartPlaybackInThisTab: () => true,
      setCurrentPlayerTrack: (track) => { context.state.player.current = track; },
      renderSelectedTrackState: () => {},
      beginStreamingPlayerListenSession: () => {},
    });
    context.state.player.current = makeTrack('01.flac');
  }
  context.observeStreamingFacadeCallback(context.playTrackFromPayload(makeTrack(name)), 'track-selection-start-error');
  return harness.settle();
}

test('a socket lost while a press waits on a cut-over opens the pressed song on the next socket', async (t) => {
  const { harness, node } = await playingSong(t);
  await pressInPlayer(harness, '05.flac');
  await answerOpen(harness, harness.sent('open').at(-1), NEXT_SONG);
  assert.equal(harness.engine.pendingSeek.prepareSent, true);
  await pressInPlayer(harness, '06.flac');

  harness.sockets[0].unexpectedClose({ code: 1006 });
  await harness.settle();
  await harness.settle();

  assert.notEqual(harness.engine.mode, 'error');
  assert.equal(harness.engine.diagnostics.lastError, undefined);
  assert.equal(harness.engine.node, node);
  assert.equal(harness.sent('open').at(-1).path, makeTrack('06.flac').path);
});

for (const failing of ['current', 'continuity']) {
  test(`a decoder failing in the ${failing} stream while a press waits on a cut-over starts the pressed song`, async (t) => {
    const { harness, node } = await playingSong(t);
    await pressInPlayer(harness, '05.flac');
    await answerOpen(harness, harness.sent('open').at(-1), NEXT_SONG);
    await pressInPlayer(harness, '06.flac');

    harness.context.failStreamingEncodedRole(harness.engine.roles[failing], 'decode-error');
    await harness.settle();
    await harness.settle();

    assert.notEqual(harness.engine.mode, 'error');
    assert.equal(harness.engine.node, node);
    assert.equal(harness.sent('open').at(-1).path, makeTrack('06.flac').path);
  });
}

for (const waiting of ['open', 'refresh']) {
  test(`a seek while a switch waits on its ${waiting} gives the press up and playback goes on`, async (t) => {
    const { harness, node } = waiting === 'refresh'
      ? await playingWithPreparedNext(t, { holdSampleRateProbes: true })
      : await playingSong(t);
    const pressed = waiting === 'refresh' ? '02.flac' : '05.flac';
    await pressInPlayer(harness, pressed);
    assert.equal(harness.context.state.player.selectedTrack.path, makeTrack(pressed).path);

    await harness.api.seek(120);
    await harness.settle();

    assert.notEqual(harness.engine.mode, 'error');
    assert.equal(harness.engine.diagnostics.lastError, undefined);
    assert.equal(harness.engine.node, node, 'the audio graph is not torn down');
    assert.equal(harness.context.state.player.selectedTrack, null, 'the title is the playing song again');
    assert.equal(harness.context.state.player.current.path, makeTrack('01.flac').path);
    assert.deepEqual(heardFor(node, 8), [OLD_SONG]);
    assert.equal(harness.sent('open').at(-1).startFrame, 120 * ONE_SECOND);
  });
}

test('a seek while a press waits on a cut-over leaves that press to start its song', async (t) => {
  const { harness, node } = await playingSong(t);
  await pressInPlayer(harness, '05.flac');
  await answerOpen(harness, harness.sent('open').at(-1), NEXT_SONG);
  await pressInPlayer(harness, '06.flac');

  await harness.api.seek(120);
  await harness.settle();
  await harness.settle();

  assert.notEqual(harness.engine.mode, 'error');
  assert.equal(harness.engine.node, node);
  assert.equal(harness.sent('open').at(-1).path, makeTrack('06.flac').path);
});

test('a failed press still ends in the player error path', async (t) => {
  const { harness } = await playingSong(t);

  harness.context.observeStreamingFacadeCallback(Promise.reject(new Error('broken')), 'track-selection-start-error');
  await harness.settle();

  assert.equal(harness.engine.mode, 'error');
});

function timedPress(harness, name) {
  harness.context.noteStreamingPress(makeTrack(name));
  return pressTrack(harness, name);
}

test('a timed press reports where it waited, in numbers only', async (t) => {
  const { harness, node } = await playingSong(t);
  harness.setNow(5_000);
  const pressed = await timedPress(harness, '05.flac');
  harness.setNow(5_080);
  acceptMetadata(harness, pressed.open, { timing: true });
  harness.setNow(5_120);
  receiveSong(harness, pressed.open, PRESSED_SONG, 2 * ONE_SECOND, 0, 1);
  await harness.settle();
  harness.setNow(5_140);
  heardFor(node, 2);

  const [report] = harness.sent('start-report');
  assert.deepEqual(report, {
    type: 'start-report',
    generation: pressed.open.generation,
    audibleStreamId: pressed.open.streamId,
    prepared: false,
    presses: 1,
    pressedAtEpochMs: report.pressedAtEpochMs,
    firstPressMs: 140,
    openMs: 0,
    metadataMs: 80,
    firstBytesMs: 120,
    decodedMs: 120,
    audibleMs: 140,
  });
  assert.ok(Number.isInteger(report.pressedAtEpochMs));
  assert.doesNotMatch(JSON.stringify(report), /05\.flac|Track|src|path|title/);
  heardFor(node, 4);
  assert.equal(harness.sent('start-report').length, 1, 'one line per press');
});

test('a timed press on the prepared next track times its refresh and no bytes', async (t) => {
  const { harness, node, next } = await playingWithPreparedNext(t, { holdSampleRateProbes: true });
  // The server asked with the metadata of a stream before this press.
  harness.engine.timingRequested = true;
  harness.setNow(5_000);
  await timedPress(harness, '02.flac');
  harness.setNow(5_600);
  answerAuthority(harness, harness.sockets[0].probes.at(-1));
  await harness.settle();
  harness.setNow(5_603);
  heardFor(node, 2);

  const [report] = harness.sent('start-report');
  assert.equal(report.audibleStreamId, next.streamId);
  assert.deepEqual(
    [report.prepared, report.openMs, report.metadataMs, report.firstBytesMs, report.decodedMs, report.audibleMs],
    [true, 0, 600, null, null, 603],
  );
});

test('a press reports nothing to a server that did not ask', async (t) => {
  const { harness, node } = await playingSong(t);
  const pressed = await timedPress(harness, '05.flac');
  await answerOpen(harness, pressed.open, PRESSED_SONG);
  heardFor(node, 4);

  assert.equal(harness.engine.startTiming, null, 'and keeps nothing once the song sounds');
  assert.equal(harness.sent('start-report').length, 0);
});

test('a report has no say over playback when its socket is closing', async (t) => {
  const { harness, node } = await playingSong(t);
  const { context, engine } = harness;
  engine.timingRequested = true;
  context.noteStreamingPress(makeTrack('01.flac'));
  context.followStreamingPress(engine.roles.current);
  harness.sockets[0].readyState = 2;

  // A kept track starts to sound with nothing else to send, so the report is the only control.
  context.markStreamingPress('audibleMs', engine.roles.current);

  assert.notEqual(engine.mode, 'error');
  assert.equal(engine.diagnostics.lastError, undefined);
  assert.equal(engine.node, node);
  assert.equal(harness.sent('start-report').length, 0);
});

test('a server that stopped asking gets no report', async (t) => {
  const { harness, node } = await playingSong(t);
  harness.engine.timingRequested = true;
  const pressed = await timedPress(harness, '05.flac');
  await answerOpen(harness, pressed.open, PRESSED_SONG);
  heardFor(node, 4);

  assert.equal(harness.sent('start-report').length, 0);
});

for (const waiting of ['open', 'refresh', 'cut-over']) {
  test(`presses on a row whose start waits on its ${waiting} are counted as one start`, async (t) => {
    const { harness, node } = waiting === 'refresh'
      ? await playingWithPreparedNext(t, { holdSampleRateProbes: true })
      : await playingSong(t);
    harness.engine.timingRequested = true;
    const row = waiting === 'refresh' ? '02.flac' : '05.flac';
    harness.setNow(5_000);
    await pressInPlayer(harness, row);
    if (waiting === 'cut-over') await answerOpen(harness, harness.sent('open').at(-1), NEXT_SONG);
    harness.setNow(6_000);
    await pressInPlayer(harness, row);
    if (waiting === 'cut-over') {
      node.render();
      node.deliverEvents();
      await harness.settle();
    }
    const open = harness.sent('open').at(-1);
    acceptMetadata(harness, open, { timing: true });
    receiveSong(harness, open, PRESSED_SONG, 2 * ONE_SECOND, 0, 1);
    await harness.settle();
    harness.setNow(6_400);
    heardFor(node, 4);

    const [report] = harness.sent('start-report');
    assert.equal(report.presses, 2);
    assert.equal(report.audibleMs, 400, 'from the last press');
    assert.equal(report.firstPressMs, 1_400, 'from the first, which is what the listener waited');
    assert.equal(harness.sent('start-report').length, 1);
  });
}

for (const between of ['another row', 'a seek that gave it up']) {
  test(`a press after ${between} is a start of its own`, async (t) => {
    const { harness, node } = await playingSong(t);
    await pressInPlayer(harness, '05.flac');
    if (between === 'another row') await pressInPlayer(harness, '06.flac');
    else await harness.api.seek(120);
    await harness.settle();
    await pressInPlayer(harness, '05.flac');
    const open = harness.sent('open').at(-1);
    acceptMetadata(harness, open, { timing: true });
    receiveSong(harness, open, PRESSED_SONG, 2 * ONE_SECOND, 0, 1);
    await harness.settle();
    heardFor(node, 4);

    const [report] = harness.sent('start-report');
    assert.equal(report.presses, 1);
  });
}

// Play again while a song is still starting is ignored.
function installRowPresses(harness, current = makeTrack('01.flac')) {
  const { context } = harness;
  loadLeaseRecoveryRuntime(harness);
  vm.runInContext(fs.readFileSync(path.join(path.dirname(enginePath), 'album-track-table.js'), 'utf8'), context);
  Object.assign(context, {
    canStartPlaybackInThisTab: () => true,
    setCurrentPlayerTrack: (track) => { context.state.player.current = track; },
    renderSelectedTrackState: () => {},
    beginStreamingPlayerListenSession: () => {},
    setAlbumPlaybackQueue: () => {},
    closeListenSegment: () => {},
    markListenSessionPaused: () => {},
    maybeScrobbleListenSession: async () => {},
    persistPausedListenSession: async () => {},
    releasePlaybackOwnership: async () => {},
    focusPlayerTimeline: () => {},
    usesMobilePageLayout: () => true,
    triggerAlbumTrackPlayActivation: () => {},
  });
  context.document = { ...(context.document || {}), getElementById: () => ({ hidden: true }) };
  context.state.player.current = current;
  const rows = new Map();
  const rowOf = (name) => {
    if (rows.has(name)) return rows.get(name);
    const track = makeTrack(name);
    const attributes = { 'data-src': track.src, 'data-track-path': track.path, 'data-track-duration-seconds': '240' };
    const button = {
      getAttribute: (key) => attributes[key] || '',
      classList: { contains: () => false },
      click: () => context.activateSharedTrackButton(button),
    };
    const row = { dataset: {}, querySelector: () => button, ownerDocument: { getSelection: () => null } };
    rows.set(name, { button, row });
    return rows.get(name);
  };
  return {
    async press(name) {
      rowOf(name).button.click();
      await harness.settle();
    },
    // The real mobile handler: the second tap of a double tap asks for a restart.
    async doubleTap(name) {
      for (const detail of [1, 2]) {
        context.handleAlbumTrackRowClick({
          detail, currentTarget: rowOf(name).row, target: { closest: () => null }, preventDefault() {},
        });
        await harness.settle();
      }
    },
  };
}

const opensOf = (harness, name) => harness.sent('open').filter(({ path: opened }) => opened === makeTrack(name).path);
const refreshesOf = (harness) => harness.sockets[0].probes.filter(({ authorityOnly }) => authorityOnly === true);

const PENDING_STARTS = {
  'over a second of the old song left': async (t) => {
    const playing = await playingSong(t);
    return { ...playing, rows: installRowPresses(playing.harness), name: '05.flac' };
  },
  'under a second of the old song left': async (t) => {
    const playing = await playingSong(t);
    heardFor(playing.node, 384);
    return { ...playing, rows: installRowPresses(playing.harness), name: '05.flac' };
  },
  'another switch pending': async (t) => {
    const playing = await playingSong(t);
    const rows = installRowPresses(playing.harness);
    await rows.press('04.flac');
    return { ...playing, rows, name: '05.flac' };
  },
  'a switch just cut over': async (t) => {
    const playing = await playingSong(t);
    const rows = installRowPresses(playing.harness);
    await rows.press('04.flac');
    await answerOpen(playing.harness, opensOf(playing.harness, '04.flac')[0], NEXT_SONG);
    playing.node.render();
    playing.node.deliverEvents();
    await playing.harness.settle();
    return { ...playing, rows, name: '05.flac' };
  },
  'the pressed row prepared as the next track': async (t) => {
    const playing = await playingWithPreparedNext(t, { holdSampleRateProbes: true });
    return { ...playing, rows: installRowPresses(playing.harness), name: '02.flac', prepared: true };
  },
};

for (const [pending, arrange] of Object.entries(PENDING_STARTS)) {
  for (const again of ['presses', 'a double tap']) {
    test(`${again} on a row still starting, with ${pending}, leave its one start waiting`, async (t) => {
      const { harness, node, rows, name, prepared } = await arrange(t);
      harness.engine.timingRequested = true;
      const opens = opensOf(harness, name).length;
      harness.setNow(5_000);
      if (again === 'presses') await rows.press(name);
      else await rows.doubleTap(name);
      harness.setNow(5_400);
      for (let press = 0; press < 3; press += 1) await rows.press(name);

      assert.equal(opensOf(harness, name).length, opens + (prepared ? 0 : 1), 'one start');
      assert.equal(refreshesOf(harness).length, prepared ? 1 : 0, 'one refresh');
      assert.equal(harness.api.snapshot().paused, false, 'ignored is not a pause');

      harness.setNow(5_700);
      if (prepared) answerAuthority(harness, refreshesOf(harness)[0]);
      else {
        const open = opensOf(harness, name).at(-1);
        acceptMetadata(harness, open, { timing: true });
        receiveSong(harness, open, PRESSED_SONG, 2 * ONE_SECOND, 0, 1);
      }
      await harness.settle();
      const levels = heardFor(node, 4);
      assert.equal(levels.at(-1), prepared ? NEXT_SONG : PRESSED_SONG, 'the one start sounds');
      const [report] = harness.sent('start-report');
      assert.equal(report.presses, again === 'presses' ? 4 : 5, 'the timing line still counts each press');
      assert.equal(report.audibleMs, 700, 'timed from the first press, whose wait was never restarted');
    });
  }
}

test('presses on a row still cutting over leave its one start', async (t) => {
  const { harness, node } = await playingSong(t);
  const rows = installRowPresses(harness);
  await rows.press('05.flac');
  await answerOpen(harness, opensOf(harness, '05.flac')[0], PRESSED_SONG);
  assert.equal(harness.engine.pendingSeek.prepareSent, true);
  await rows.press('05.flac');
  await rows.doubleTap('05.flac');

  assert.deepEqual(heardFor(node, 4), [PRESSED_SONG]);
  await harness.settle();
  assert.equal(opensOf(harness, '05.flac').length, 1);
  assert.equal(harness.api.snapshot().paused, false);
});

async function coldStartPending(t, options = {}) {
  const harness = createEngineHarness({ realProcessor: true, ...options });
  t.after(() => harness.api.stop());
  const rows = installRowPresses(harness, null);
  await rows.press('05.flac');
  await harness.settle();
  return { harness, rows };
}

test('with nothing playing, presses and a double tap before the song sounds neither pause nor restart it', async (t) => {
  const { harness, rows } = await coldStartPending(t);
  assert.equal(harness.api.snapshot().mode, 'starting');
  await rows.press('05.flac');
  await rows.doubleTap('05.flac');

  const opens = opensOf(harness, '05.flac');
  assert.equal(opens.length, 1);
  assert.equal(harness.api.snapshot().paused, false);
  acceptMetadata(harness, opens[0]);
  receiveSong(harness, opens[0], PRESSED_SONG, 2 * ONE_SECOND);
  await harness.settle();
  assert.deepEqual(heardFor(harness.nodes[0], 4), [PRESSED_SONG]);
  await harness.settle();

  await rows.press('05.flac');
  assert.equal(harness.api.snapshot().paused, true, 'once it sounds its row pauses it as ever');
});

test('once a switched-to song sounds its row pauses it as ever', async (t) => {
  const { harness, node } = await playingSong(t);
  const rows = installRowPresses(harness);
  await rows.press('05.flac');
  await answerOpen(harness, opensOf(harness, '05.flac')[0], PRESSED_SONG);
  heardFor(node, 4);
  await harness.settle();

  await rows.press('05.flac');
  assert.equal(harness.api.snapshot().paused, true);
});

test('a double tap on a song already sounding still restarts it', async (t) => {
  const { harness } = await playingSong(t);
  const rows = installRowPresses(harness);
  const opens = opensOf(harness, '01.flac').length;
  await rows.doubleTap('01.flac');

  assert.equal(opensOf(harness, '01.flac').length, opens + 1);
});

// The pressed song's title and row stayed after the switch it named was given up.
for (const ended of ['Pause', 'Play of the paused song']) {
  test(`${ended} during a pending switch stops naming its song`, async (t) => {
    const { harness } = await playingSong(t);
    const rows = installRowPresses(harness);
    const { context } = harness;
    let drawn = null;
    context.renderSelectedTrackState = () => {
      drawn = context.state.player.selectedTrack?.path || context.state.player.current.path;
    };
    await rows.press('05.flac');
    assert.equal(drawn, makeTrack('05.flac').path, 'the pressed song is named from its press, as ever');

    if (ended === 'Pause') context.togglePlayerPlayback();
    else {
      // Paused by something other than the player's own Pause, which would already have superseded it.
      harness.engine.snapshot.paused = true;
      context.togglePlayerPlayback();
    }
    await harness.settle();

    assert.equal(context.state.player.selectedTrack, null);
    assert.equal(drawn, makeTrack('01.flac').path, 'the player and its rows show the playing song again');
  });
}

test('a press on another song during a pending switch names that song at once, and never the playing one between', async (t) => {
  const { harness } = await playingSong(t);
  const rows = installRowPresses(harness);
  const { context } = harness;
  const drawn = [];
  context.renderSelectedTrackState = () => {
    drawn.push(context.state.player.selectedTrack?.path || context.state.player.current.path);
  };
  await rows.press('05.flac');
  await rows.press('06.flac');

  assert.deepEqual(drawn, [makeTrack('05.flac').path, makeTrack('06.flac').path]);
});

// A seek's socket was replaced while its heartbeats waited to be read by a busy page.
async function seekWaitingOnTheServer() {
  // Every later socket is refused: on real timers its reconnects would retry for ever.
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    refuseConnection: (count) => count > 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const open = await startLocallySeekable(harness, 100_000);
  harness.setNow(1_000);
  await harness.api.seek(60);
  await settleTwice(harness);
  const position = (contextTime) => harness.nodes[0].port.dispatch({
    type: 'position', generation: open.generation, streamId: open.streamId, timelineFrame: 100, contextTime,
  });
  return { harness, position };
}

for (const heard of [true, false]) {
  test(`a late page reads its socket before a seek's silence counts (${heard ? 'a heartbeat was waiting' : 'nothing was'})`, async () => {
    const { harness, position } = await seekWaitingOnTheServer();
    harness.setNow(1_900);
    // Rendered at 11.6 s, read at 12.5 s: the page is 900 ms behind, and so may its socket be.
    position(11.6);
    position(12.5);
    await settleTwice(harness);
    assert.equal(harness.sockets[0].closeCalls, 0, 'neither the late message nor the backlog after it decides');

    if (heard) harness.sockets[0].receive({ type: 'heartbeat' });
    harness.setNow(2_000);
    position(12.5);
    await settleTwice(harness);

    assert.equal(harness.sockets[0].closeCalls, heard ? 0 : 1);
    if (heard) assert.equal(harness.engine.pendingSeek.prepareSent, false, 'the seek still waits on its own open');
  });
}

for (const heard of [true, false]) {
  test(`an interval check that ran late also reads the socket before a seek is given up (${heard ? 'heard' : 'silent'})`, async () => {
    const { harness } = await seekWaitingOnTheServer();
    checkLivenessUntil(harness, 500, 1_000);
    // 800 ms since the last check: over a heartbeat late, though not late enough to skip.
    harness.setNow(1_800);
    liveness(harness).callback();
    await settleTwice(harness);
    assert.equal(harness.sockets[0].closeCalls, 0, 'the late check waits for the read');

    if (heard) harness.sockets[0].receive({ type: 'heartbeat' });
    harness.setNow(1_900);
    liveness(harness).callback();
    await settleTwice(harness);
    assert.equal(harness.sockets[0].closeCalls, heard ? 0 : 1);
  });
}

test('on a page that keeps up, 750 ms of silence still gives a seek up at once', async () => {
  const { harness, position } = await seekWaitingOnTheServer();
  harness.setNow(1_760);
  position(12.45);
  await settleTwice(harness);

  assert.equal(harness.sockets[0].closeCalls, 1);
});

// A seek made while another waited always asked the server, also for bytes already here.
for (const waitingOn of ['the server', 'received bytes']) {
  test(`a seek while another waits on ${waitingOn} reads the received bytes, with no round trip`, async () => {
    const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
    const open = await startLocallySeekable(harness, 100_000);
    const opensBefore = harness.sent('open').length;
    // Both seeks land in one task, before the first could decode its quarter second.
    void harness.api.seek(waitingOn === 'the server' ? 30 : 10);
    const waiting = harness.engine.roles.continuity;
    assert.equal(harness.engine.pendingSeek.prepareSent, false, 'the first seek still waits');
    const opens = harness.sent('open').length;
    assert.equal(opens, opensBefore + (waitingOn === 'the server' ? 1 : 0));

    const second = harness.api.seek(12);

    const local = harness.engine.roles.continuity;
    assert.notEqual(local, waiting);
    assert.equal(local.local, true);
    assert.equal(harness.sent('open').length, opens, 'the server is not asked again');
    assert.equal(harness.engine.pendingSeek.streamId, local.streamId);
    assert.equal(harness.engine.pendingSeek.startFrame, 576_000);
    assert.equal(harness.portMessages('reserve-seek').at(-1).streamId, local.streamId);
    assert.deepEqual(harness.sent('close').map(({ streamId }) => streamId),
      waitingOn === 'the server' ? [waiting.streamId] : [], 'only the waiting seek stream closes on the server');

    await second;
    await harness.settle();
    harness.nodes[0].port.dispatch({
      type: 'seek-boundary', generation: open.generation, outgoingStreamId: open.streamId,
      incomingStreamId: local.streamId, renderedFrame: 128, timelineFrame: 576_000, silentFrames: 0,
    });
    assert.equal(harness.engine.roles.current, local);
    assert.equal(harness.api.snapshot().currentTime, 12);
  });
}

test('a seek while another already cuts over still asks the server', async () => {
  const harness = encodedHarness({ createStreamingDecoder: recordingDecoders().create });
  await startLocallySeekable(harness, 100_000);
  await harness.api.seek(30);
  harness.engine.pendingSeek.prepareSent = true;
  const opens = harness.sent('open').length;

  await harness.api.seek(12);

  assert.equal(harness.sent('open').length, opens + 1);
});

// A lost press left no line, and no control said when the page sent it.
test('with timing asked, an open and a refresh probe say when the page sent them', async (t) => {
  const { harness } = await playingWithPreparedNext(t, { holdSampleRateProbes: true });
  assert.equal(harness.sent('open')[0].clientSentAtEpochMs, undefined, 'nothing is added before the server asks');
  harness.engine.timingRequested = true;

  await pressTrack(harness, '02.flac');
  assert.equal(harness.sockets[0].probes.at(-1).clientSentAtEpochMs, harness.dateNow());
  await pressTrack(harness, '05.flac');
  assert.equal(harness.sent('open').at(-1).clientSentAtEpochMs, harness.dateNow());
});

for (const ended of ['replaced', 'paused', 'seek', 'stopped']) {
  test(`a press that never sounded reports that it was ${ended}, in numbers only`, async (t) => {
    const { harness } = await playingSong(t);
    Object.assign(harness.engine, { timingRequested: true, unheardRequested: true });
    harness.setNow(5_000);
    const pressed = await timedPress(harness, '05.flac');
    harness.setNow(5_900);
    if (ended === 'replaced') harness.context.noteStreamingPress(makeTrack('06.flac'));
    else if (ended === 'paused') await harness.api.pause();
    else if (ended === 'seek') await harness.api.seek(120);
    else await harness.api.stop();
    await harness.settle();

    const [report, ...more] = harness.sent('unheard-report');
    assert.equal(more.length, 0, 'one line');
    assert.deepEqual(report, {
      type: 'unheard-report',
      outcome: ended,
      prepared: false,
      pressedStreamId: pressed.open.streamId,
      presses: 1,
      pressedAtEpochMs: report.pressedAtEpochMs,
      firstPressMs: 900,
      openMs: 0,
      metadataMs: null,
      firstBytesMs: null,
      decodedMs: null,
      prepareMs: null,
      endedMs: 900,
    });
    assert.doesNotMatch(JSON.stringify(report), /05\.flac|Track|src|path|title/);
  });
}

test('a press still silent after fifteen seconds says so once, and goes on waiting', async (t) => {
  const { harness, node } = await playingSong(t);
  Object.assign(harness.engine, { timingRequested: true, unheardRequested: true });
  harness.setNow(5_000);
  const pressed = await timedPress(harness, '05.flac');
  for (const now of [19_500, 20_000, 20_500]) {
    harness.setNow(now);
    harness.sockets[0].receive({ type: 'heartbeat' });
    liveness(harness).callback();
  }
  assert.deepEqual(harness.sent('unheard-report').map(({ outcome }) => outcome), ['waiting']);

  acceptMetadata(harness, pressed.open, { timing: true, timingUnheard: true });
  receiveSong(harness, pressed.open, PRESSED_SONG, 2 * ONE_SECOND, 0, 1);
  await harness.settle();
  heardFor(node, 2);
  assert.equal(harness.sent('start-report').length, 1, 'and still reports when it sounds');
});

test('a server that did not ask for unheard presses gets none', async (t) => {
  const { harness } = await playingSong(t);
  harness.engine.timingRequested = true;
  await timedPress(harness, '05.flac');
  await harness.api.pause();

  assert.equal(harness.sent('unheard-report').length, 0);
});

test('a press on a different song still switches, and back', async (t) => {
  const { harness, node } = await playingSong(t);
  const rows = installRowPresses(harness);
  await rows.press('05.flac');
  await rows.press('06.flac');
  assert.equal(opensOf(harness, '06.flac').length, 1);
  await rows.press('05.flac');

  const opens = opensOf(harness, '05.flac');
  assert.equal(opens.length, 2, 'the song pressed first is another song by then');
  await answerOpen(harness, opens.at(-1), PRESSED_SONG);
  assert.deepEqual(heardFor(node, 4), [PRESSED_SONG]);
});

for (const ended of ['Pause', 'a seek']) {
  test(`after ${ended} gave a pending start up, its row starts it again at once`, async (t) => {
    const { harness } = await playingSong(t);
    const rows = installRowPresses(harness);
    await rows.press('05.flac');
    if (ended === 'Pause') {
      harness.context.togglePlayerPlayback();
      await harness.settle();
      assert.equal(harness.api.snapshot().paused, true, 'Pause is unchanged');
    } else await harness.api.seek(120);
    await harness.settle();
    await rows.press('05.flac');
    await harness.settle();

    assert.equal(opensOf(harness, '05.flac').length, 2);
  });
}

for (const when of ['before', 'after']) {
  test(`a start that failed ${when} the player took the song can be pressed again at once`, async (t) => {
    let harness;
    let rows;
    if (when === 'before') {
      ({ harness } = await playingSong(t));
      rows = installRowPresses(harness);
      await rows.press('05.flac');
    } else {
      ({ harness, rows } = await coldStartPending(t));
      assert.equal(harness.context.state.player.current.path, makeTrack('05.flac').path);
    }
    harness.sockets[0].unexpectedClose({ code: 4404 });
    await harness.settle();
    await harness.settle();
    assert.equal(harness.engine.mode, 'error');
    await rows.press('05.flac');
    await harness.settle();
    await harness.settle();

    assert.notEqual(harness.engine.mode, 'error');
    assert.equal(harness.sockets.length, 2, 'it starts again on a new socket');
  });
}

test('a start with no sound after fifteen seconds has timed out and can be pressed again', async (t) => {
  const { harness } = await playingSong(t);
  const rows = installRowPresses(harness);
  harness.setNow(10_000);
  await rows.press('05.flac');
  harness.setNow(24_999);
  await rows.press('05.flac');
  assert.equal(opensOf(harness, '05.flac').length, 1);
  harness.setNow(25_000);
  await rows.press('05.flac');

  assert.equal(opensOf(harness, '05.flac').length, 2);
});

test('an ignored press while the connection is gone retries the connection at once and keeps the one start', async (t) => {
  const timers = manualTimers();
  const harness = createEngineHarness({
    refuseConnection: (count) => (count === 2 ? 'hang' : false),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  t.after(() => harness.api.stop());
  await harness.api.start(makeTrack('01.flac'));
  const rows = installRowPresses(harness);
  await rows.press('05.flac');
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  assert.equal(harness.sockets[1]?.readyState, 0, 'the attempt begun in the outage hangs');
  const started = harness.engine.startRequestId;

  await rows.press('05.flac');
  await settleTwice(harness);
  await settleTwice(harness);

  assert.equal(harness.sockets[1].closeCalls, 1, 'the hanging attempt is given up');
  assert.equal(harness.sockets.length, 3, 'a fresh attempt starts at once');
  assert.equal(harness.engine.startRequestId, started, 'without starting the song again');
});

// Bounded-interaction contracts (tests/ci/bounded-interactions.json): a socket chunk or a worklet
// message decodes one fixed-size buffer and publishes fixed-shape diagnostics however long the
// session has been playing.
async function startCountedStreamingSession(counter, options = {}) {
  const harness = createEngineHarness({
    ...options,
    sendSocket: () => counter.count('requests'),
    handleStreamingPlaybackPosition: () => counter.count('renderCommits'),
  });
  harness.context.document = { documentElement: { setAttribute(_name, value) {
    counter.count('domMutations');
    counter.count('markupBytes', String(value).length);
  } } };
  await harness.api.start(makeTrack());
  await harness.settle();
  const current = harness.sent('open')[0];
  acceptMetadata(harness, current);
  const port = harness.nodes[0].port;
  const post = port.postMessage.bind(port);
  port.postMessage = (...args) => { counter.count('outputEmissions'); return post(...args); };
  port.dispatch({ type: 'first-frame', generation: current.generation, streamId: current.streamId, renderedFrame: 0, contextTime: 12.5 });
  let sequence = 0;
  let nowMs = 1000;
  // One 2-frame chunk arrives, the worklet plays it, and reports its position 100 ms later.
  const playChunk = () => {
    receivePcmAndAssertEnqueue(harness, { generation: current.generation, streamId: current.streamId, sequence });
    sequence += 1;
    port.dispatch({ type: 'consumed', generation: current.generation, streamId: current.streamId, role: 'current', frames: 2, bufferedFrames: 0 });
    nowMs += 100;
    harness.setNow(nowMs);
    port.dispatch({ type: 'position', generation: current.generation, streamId: current.streamId, timelineFrame: sequence * 2 });
  };
  return { harness, playChunk, chunks: () => sequence };
}

test('bounded interaction: streaming socket chunks and worklet messages stay constant over a 10,000-chunk session', async () => {
  const { createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter.js');
  const run = async (sessionChunks) => {
    const counter = createInteractionCounter();
    const session = await startCountedStreamingSession(counter);
    for (let chunk = 0; chunk < sessionChunks; chunk += 1) session.playChunk();
    const work = await counter.measure(() => {
      for (let chunk = 0; chunk < 10; chunk += 1) session.playChunk();
    });
    assert.equal(session.harness.engine.mode, 'playing');
    assert.equal(session.harness.portMessages('enqueue').length, sessionChunks + 10, 'every chunk reaches the worklet');
    return work;
  };
  await measureScalePair({
    id: 'js:runtime/player-streaming-engine.js#prepareStreamingPlaybackEngine',
    small: 10,
    large: 10000,
    run,
    budgets: { outputEmissions: 10, requests: 0, renderCommits: 3, domMutations: 10, markupBytes: 13000 },
    growth: { metric: 'outputEmissions', largeMinusSmallMax: 0 },
  });
});

test('bounded interaction: the streaming keepalive sends one control per tick over a 1,000-tick pause', async () => {
  const { createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter.js');
  const run = async (ticks) => {
    const counter = createInteractionCounter();
    const { harness } = await startCountedStreamingSession(counter);
    await harness.api.pause();
    const keepalive = harness.intervals.find(({ delay }) => delay === 25_000).callback;
    for (let tick = 0; tick < ticks; tick += 1) keepalive();
    const work = await counter.measure(() => {
      for (let tick = 0; tick < 10; tick += 1) keepalive();
    });
    assert.equal(harness.sent('keepalive').length, ticks + 10);
    return work;
  };
  await measureScalePair({
    id: 'js:runtime/player-streaming-engine.js#keepStreamingSocketAlive',
    small: 10,
    large: 1000,
    run,
    budgets: { requests: 10, outputEmissions: 0, domMutations: 0 },
    growth: { metric: 'requests', largeMinusSmallMax: 0 },
  });
});

/** A playing song whose socket is lost; [refuse] answers each later attempt as the test's network does. */
async function startCountedOutage(counter, refuse, options = {}) {
  const timers = manualTimers();
  const harness = encodedHarness({
    createStreamingDecoder: recordingDecoders().create,
    // Every socket the engine opens is counted, refused or not.
    refuseConnection: (count) => {
      counter.count('requests');
      return count > 1 ? refuse : false;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...options,
  });
  await startLocallySeekable(harness, 100_000);
  await harness.api.resume();
  harness.sockets[0].unexpectedClose();
  await settleTwice(harness);
  return { harness, timers };
}

test('bounded interaction: a reconnect retry asks once and opens one socket per tick over a 1,000-attempt outage', async () => {
  const { createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter.js');
  const run = async (attempts) => {
    const counter = createInteractionCounter();
    const asked = [];
    // The server answers its questions, but the network refuses every socket.
    const fetch = async (url) => {
      counter.count('requests');
      asked.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const { harness, timers } = await startCountedOutage(counter, true, { fetch });
    const retry = async () => {
      timers.fire(timers.pending().find(({ delay }) => delay <= 1_000));
      await settleTwice(harness);
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) await retry();
    const opened = harness.sockets.length;
    const questions = asked.length;
    const work = await counter.measure(async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) await retry();
    });
    assert.equal(harness.sockets.length, opened + 10, 'one socket per retry');
    assert.deepEqual(asked.slice(questions), Array(10).fill('/playback/state'), 'one question per retry');
    assert.notEqual(harness.api.snapshot().mode, 'error', 'failed attempts never end the wait');
    return work;
  };
  await measureScalePair({
    id: 'js:runtime/player-streaming-engine.js#scheduleStreamingReconnect',
    small: 10,
    large: 1000,
    run,
    budgets: { requests: 20 },
    growth: { metric: 'requests', largeMinusSmallMax: 0 },
  });
});

test('bounded interaction: a hung connect given up at its deadline opens one socket per cycle over 1,000 attempts', async () => {
  const { createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter.js');
  const run = async (attempts) => {
    const counter = createInteractionCounter();
    const { harness, timers } = await startCountedOutage(counter, 'hang');
    const giveUp = async () => {
      timers.fire(timers.pending().find(({ delay }) => delay >= 4_000));
      await settleTwice(harness);
      const retry = timers.pending().find(({ delay }) => delay <= 2_000);
      if (retry) timers.fire(retry);
      await settleTwice(harness);
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) await giveUp();
    const opened = harness.sockets.length;
    const work = await counter.measure(async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) await giveUp();
    });
    assert.equal(harness.sockets.length, opened + 10, 'one socket per deadline');
    assert.notEqual(harness.api.snapshot().mode, 'error', 'hung attempts never end the wait');
    return work;
  };
  await measureScalePair({
    id: 'js:runtime/player-streaming-engine.js#connectStreamingSocket',
    small: 10,
    large: 1000,
    run,
    budgets: { requests: 10 },
    growth: { metric: 'requests', largeMinusSmallMax: 0 },
  });
});

test('bounded interaction: the socket liveness check does no work per tick over a 1,000-tick session', async () => {
  const { createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter.js');
  const run = async (ticks) => {
    const counter = createInteractionCounter();
    const { harness } = await startCountedStreamingSession(counter);
    const socket = harness.engine.socket;
    const check = liveness(harness).callback;
    for (let tick = 0; tick < ticks; tick += 1) check();
    const work = await counter.measure(() => {
      for (let tick = 0; tick < 10; tick += 1) check();
    });
    assert.equal(harness.engine.socket, socket, 'a socket that is heard is kept');
    return work;
  };
  await measureScalePair({
    id: 'js:runtime/player-streaming-engine.js#watchStreamingSocketLiveness',
    small: 10,
    large: 1000,
    run,
    budgets: { requests: 0, outputEmissions: 0, domMutations: 0 },
    growth: { metric: 'requests', largeMinusSmallMax: 0 },
  });
});

test('request capture: the reachability probe asks only the playback state, once per tick, over a 1,000-tick outage', async () => {
  const { createInteractionCounter } = require('../helpers/bounded-interaction-counter.js');
  const { createRequestCapture, measureInteractionContract } = require('../helpers/request-capture.js');
  await measureInteractionContract('js:runtime/player-streaming-engine.js#probeStreamingReachability', {
    setup: async (ticks) => {
      // The network is frozen: attempts hang and the server does not answer.
      const capture = createRequestCapture(() => Promise.reject(new TypeError('Failed to fetch')));
      const { harness } = await startCountedOutage(createInteractionCounter(), 'hang', { fetch: capture.fetch });
      // The attempt has hung well past a healthy connect.
      harness.setNow(5_000);
      const probe = () => harness.intervals.filter(({ delay }) => delay === 400).at(-1).callback();
      for (let tick = 0; tick < ticks; tick += 1) await probe();
      return { harness, capture, probe };
    },
    act: async ({ harness, capture, probe }) => {
      const sockets = harness.sockets.length;
      const sent = capture.requests.length;
      for (let tick = 0; tick < 10; tick += 1) await probe();
      assert.equal(harness.sockets.length, sockets, 'while the server does not answer, the attempt waits');
      return { requests: capture.urls().slice(sent) };
    },
  });
});
