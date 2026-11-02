const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const runtimeDir = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime');
const fixture = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'android-bridge-v1.json'), 'utf8'));
const handshakePayload = fixture.handshakeResponse.payload;
const LOAD_KEYS = Object.keys(fixture.loadQueueRequest.payload).sort();
const ITEM_KEYS = Object.keys(fixture.loadQueueRequest.payload.items[0]).sort();

const tracks = ['Signal A', 'Signal B', 'Signal C'].map((title, index) => ({
  path: `C:/Music/Android Acceptance/0${index + 1} ${title}.flac`,
  src: `/track?id=${index}`,
  title,
  artist: 'Android Acceptance',
  album: 'Playback Ownership',
  durationSeconds: 180,
}));

function createHarness({ shell = true, refs = null } = {}) {
  const calls = [];
  const fetches = [];
  const bridge = {
    sent: [],
    postMessage(raw) {
      const message = JSON.parse(raw);
      bridge.sent.push(message);
      const payload = message.name === 'bridge.handshake'
        ? handshakePayload
        : { ok: true, ...(message.name === 'playback.loadQueue' ? { queueRevision: message.payload.queueRevision } : {}) };
      queueMicrotask(() => bridge.onmessage({ data: JSON.stringify({ ...message, type: 'response', payload }) }));
    },
    event(name, payload) {
      bridge.onmessage({ data: JSON.stringify({ protocol: 1, id: crypto.randomUUID(), type: 'event', name, payload }) });
    },
  };
  const forbidden = name => class { constructor() { throw new Error(`${name} must not start inside a native shell`); } };
  const window = { crypto, AudioContext: forbidden('AudioContext'), WebSocket: forbidden('WebSocket') };
  if (shell) window.AlbumHavenBridge = bridge;
  const context = {
    window,
    console,
    crypto,
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance: { now: () => 0 },
    AudioContext: window.AudioContext,
    WebSocket: window.WebSocket,
    state: {
      player: {
        playbackQueue: { tracks, currentIndex: 0 },
        current: null,
        streaming: {
          mode: 'stopped', generation: 0, roles: { current: null, continuity: null },
          snapshot: { currentTime: 0, duration: 0, paused: true, ended: false, src: '', readyState: 0 },
          diagnostics: { bufferedFrames: { current: 0, continuity: 0 }, inFlightFrames: { current: 0, continuity: 0 }, activeRoles: [] },
        },
      },
    },
    fetch: async (url, init) => {
      fetches.push({ url, init, body: JSON.parse(init.body) });
      const body = fetches.at(-1).body;
      const issued = refs ? refs(body) : {
        protocol: 1,
        expiresAt: '2026-11-03T00:00:00+00:00',
        tracks: body.tracks.map((track, index) => ({ clientKey: track.clientKey, playbackRef: `opaque-ref-${index}` })),
      };
      return { ok: true, json: async () => issued };
    },
    handleStreamingPlaybackFirstFrame: async event => { calls.push(['firstFrame', event]); },
    handleStreamingPlaybackPosition: async event => { calls.push(['position', event]); },
    handleStreamingPlaybackBoundary: async event => { calls.push(['boundary', event]); },
    handleStreamingPlaybackEnded: async event => { calls.push(['ended', event]); },
    updatePlayerUi: () => {},
  };
  vm.createContext(context);
  for (const file of ['player-streaming-engine.js', 'android-bridge-client.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtimeDir, file), 'utf8'), context, { filename: file });
  }
  vm.runInContext(`globalThis.api = { connectAndroidBridge, androidNativePlaybackRoute, isAndroidNativePlayback,
    getAndroidNativePlaybackClientId, start: startStreamingTrack, pause: pauseStreamingPlayback,
    resume: resumeStreamingPlayback, seek: seekStreamingPlayback, continuity: scheduleStreamingContinuity,
    setLoop: setStreamingLoop, stop: stopStreamingPlayback, snapshot: getStreamingPlaybackSnapshot };`, context);
  return { api: context.api, bridge, calls, fetches, context };
}

const commands = (bridge, name) => bridge.sent.filter(message => message.name === name);
const settle = () => new Promise(resolve => setImmediate(resolve));

function state(revision, nativeState, positionMs = 0, currentIndex = 0) {
  return { ...fixture.stateEvent.payload, queueRevision: revision, state: nativeState, positionMs, currentIndex };
}

test('ordinary browsers keep the AudioWorklet path and never touch native playback', async () => {
  const { api, fetches } = createHarness({ shell: false });
  assert.equal(api.androidNativePlaybackRoute(), null);
  assert.equal(api.isAndroidNativePlayback(), false);
  assert.equal(api.getAndroidNativePlaybackClientId(), '');
  assert.equal(api.snapshot().diagnostics.native, undefined);
  assert.equal(fetches.length, 0);
});

test('a negotiated native shell routes a start through one reference batch and a path-free loadQueue', async () => {
  const { api, bridge, fetches } = createHarness();
  const role = await api.start(tracks[0], { startSeconds: 1.5, autoplay: true });

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, '/playback/refs');
  assert.equal(fetches[0].init.method, 'POST');
  assert.deepEqual(fetches[0].body.tracks.map(track => track.path), tracks.map(track => track.path));
  const [load] = commands(bridge, 'playback.loadQueue');
  assert.deepEqual(Object.keys(load.payload).sort(), LOAD_KEYS);
  assert.deepEqual(load.payload.items.map(item => Object.keys(item).sort()), tracks.map(() => ITEM_KEYS));
  assert.deepEqual(load.payload.items.map(item => item.playbackRef), ['opaque-ref-0', 'opaque-ref-1', 'opaque-ref-2']);
  assert.equal(load.payload.queueRevision, 1);
  assert.equal(load.payload.positionMs, 1500);
  assert.equal(load.payload.autoplay, true);
  assert.equal(load.payload.items[0].durationMs, 180000);
  assert.ok(bridge.sent.every(message => !JSON.stringify(message).includes('C:/Music')));
  assert.equal(role.track, tracks[0]);
  assert.equal(api.snapshot().diagnostics.native, true);
  assert.equal(api.getAndroidNativePlaybackClientId(), handshakePayload.playback.clientId);
});

test('a partial reference batch never reaches the native queue', async () => {
  const { api, bridge } = createHarness({
    refs: body => ({ protocol: 1, tracks: body.tracks.slice(1).map(track => ({ clientKey: track.clientKey, playbackRef: 'r' })) }),
  });
  await assert.rejects(api.start(tracks[0]), /Playback references are unavailable/);
  assert.equal(commands(bridge, 'playback.loadQueue').length, 0);
});

test('an overtaken start sends nothing and revisions keep increasing', async () => {
  const { api, bridge } = createHarness();
  await api.connectAndroidBridge();
  const [first, second] = await Promise.all([api.start(tracks[0]), api.start(tracks[1])]);
  assert.equal(first, null);
  assert.equal(second.track, tracks[1]);
  const loads = commands(bridge, 'playback.loadQueue');
  assert.deepEqual(loads.map(load => load.payload.queueRevision), [2]);
  assert.equal(loads[0].payload.items.length, 2);
});

test('native events drive the existing player facade callbacks and stale revisions are ignored', async () => {
  const { api, bridge, calls } = createHarness();
  await api.start(tracks[0]);

  bridge.event('playback.state', state(0, 'playing', 9000));
  assert.equal(calls.length, 0);
  bridge.event('playback.state', state(1, 'playing', 250));
  bridge.event('playback.position', state(1, 'playing', 1250));
  assert.equal(api.snapshot().currentTime, 1.25);
  assert.equal(api.snapshot().paused, false);
  bridge.event('playback.currentItem', { ...state(1, 'playing', 0, 1), reason: 'advance' });
  bridge.event('playback.currentItem', { ...state(1, 'playing', 0, 1), reason: 'load' });

  assert.deepEqual(calls.map(([name]) => name), ['firstFrame', 'position', 'boundary']);
  assert.equal(calls[0][1].trackPath, tracks[0].path);
  assert.equal(calls[1][1].currentTime, 1.25);
  assert.equal(calls[2][1].outgoingTrackPath, tracks[0].path);
  assert.equal(calls[2][1].incomingTrackPath, tracks[1].path);
  assert.equal(calls[2][1].continuityKind, 'queued-next');
  assert.equal(api.snapshot().duration, 180);

  bridge.event('playback.currentItem', { ...state(1, 'playing', 0, 2), reason: 'advance' });
  bridge.event('playback.state', state(1, 'ended', 180000, 2));
  assert.equal(calls.at(-1)[0], 'ended');
  assert.equal(calls.at(-1)[1].trackPath, tracks[2].path);
  assert.equal(api.snapshot().ended, true);
});

test('transport commands name the applied revision and continuity reuses the native queue', async () => {
  const { api, bridge } = createHarness();
  await api.start(tracks[0]);
  bridge.event('playback.state', state(1, 'playing'));

  await api.pause();
  assert.equal(api.snapshot().paused, true);
  assert.equal(await api.resume(), true);
  await api.seek(42.5);
  assert.equal(await api.continuity(tracks[1]) !== null, true);
  await api.continuity(tracks[0], { kind: 'long-loop', startSeconds: 10, endSeconds: 20 });
  api.setLoop(false);
  await settle();
  await api.stop('stopped');

  assert.deepEqual(commands(bridge, 'playback.pause').map(message => message.payload), [{}]);
  assert.deepEqual(commands(bridge, 'playback.play').map(message => message.payload), [{ queueRevision: 1 }]);
  assert.deepEqual(commands(bridge, 'playback.seek').map(message => message.payload), [{ queueRevision: 1, positionMs: 42500 }]);
  assert.deepEqual(commands(bridge, 'playback.setLoop').map(message => message.payload),
    [{ queueRevision: 1, startFrame: 480000, endFrame: 960000 }]);
  assert.deepEqual(commands(bridge, 'playback.clearLoop').map(message => message.payload), [{ queueRevision: 1 }]);
  assert.equal(commands(bridge, 'playback.stop').length, 1);
  assert.equal(commands(bridge, 'playback.loadQueue').length, 1);
  assert.equal(api.snapshot().mode, 'stopped');
});

test('a changed successor reloads the queue from the heard position', async () => {
  const { api, bridge, context } = createHarness();
  await api.start(tracks[0]);
  bridge.event('playback.state', state(1, 'playing', 30000));
  context.state.player.playbackQueue = { tracks: [tracks[0], tracks[2]], currentIndex: 0 };

  await api.continuity(tracks[2]);
  const loads = commands(bridge, 'playback.loadQueue');
  assert.equal(loads.length, 2);
  assert.equal(loads[1].payload.queueRevision, 2);
  assert.equal(loads[1].payload.positionMs, 30000);
  assert.equal(loads[1].payload.items.length, 2);
});
