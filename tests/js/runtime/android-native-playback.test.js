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

function createHarness({ shell = true, refs = null, respond = null, listen = false } = {}) {
  const calls = [];
  const fetches = [];
  const bridge = {
    sent: [],
    postMessage(raw) {
      const message = JSON.parse(raw);
      bridge.sent.push(message);
      const payload = (respond && respond(message)) || (message.name === 'bridge.handshake'
        ? handshakePayload
        : { ok: true, ...(message.name === 'playback.loadQueue' ? { queueRevision: message.payload.queueRevision } : {}) });
      Promise.resolve(payload).then(answer => bridge.onmessage({
        data: JSON.stringify({ ...message, type: 'response', payload: answer }),
      }));
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
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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
  const files = ['player-streaming-engine.js', 'android-bridge-client.js',
    ...(listen ? ['player-listen-session-helpers.js', 'playback-ownership-helpers.js'] : [])];
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(runtimeDir, file), 'utf8'), context, { filename: file });
  }
  vm.runInContext(`globalThis.api = { connectAndroidBridge, androidNativePlaybackRoute, isAndroidNativePlayback,
    getAndroidNativePlaybackClientId, start: startStreamingTrack, pause: pauseStreamingPlayback,
    resume: resumeStreamingPlayback, seek: seekStreamingPlayback, continuity: scheduleStreamingContinuity,
    setLoop: setStreamingLoop, stop: stopStreamingPlayback, snapshot: getStreamingPlaybackSnapshot,
    native: androidNativePlayback };`, context);
  if (listen) {
    vm.runInContext(`Object.assign(globalThis.api, { postPlaybackSession, canEmitPlaybackSessionSideEffects,
      releasePlaybackOwnership, getPlaybackClaimContext });`, context);
  }
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

test('Android sends listen writes with its own claim, so the WebView never holds a token', async () => {
  const answers = [
    { ok: true, status: 200, data: { ok: true, now_playing: true } },
    { ok: true, status: 409, data: { ok: false, error: 'account_scoped_scrobble_unavailable' } },
    { ok: false, error: { code: 'not_owner', message: 'This app does not own playback' } },
  ];
  const { api, bridge, fetches } = createHarness({
    listen: true,
    respond: message => (message.name === 'playback.listenEffect' ? answers.shift() : null),
  });
  await api.start(tracks[0]);
  const payload = { title: 'Signal A', artist: 'Android Acceptance', path: tracks[0].path, measurement_version: 'rendered-pcm-v1' };

  assert.equal(JSON.stringify(await api.postPlaybackSession('/playback/session/now-playing', payload)),
    JSON.stringify({ ok: true, now_playing: true }));
  await assert.rejects(api.postPlaybackSession('/playback/session/scrobble', payload), /account_scoped_scrobble_unavailable/);
  await assert.rejects(api.postPlaybackSession('/playback/session/complete', payload), /does not own playback/);

  const effects = commands(bridge, 'playback.listenEffect').map(message => message.payload);
  assert.deepEqual(effects.map(effect => effect.effect), ['now-playing', 'scrobble', 'complete']);
  assert.ok(effects.every(effect => !('claimToken' in effect.body) && !('clientId' in effect.body)));
  assert.equal(effects[0].body.title, 'Signal A');
  assert.equal(JSON.stringify(api.getPlaybackClaimContext()), '{}');
  assert.ok(fetches.every(request => !request.url.startsWith('/playback/session')));
});

test('native ownership authorizes listen writes from the start until Android releases its claim', async () => {
  const { api, bridge } = createHarness({ listen: true });
  await api.connectAndroidBridge();
  assert.equal(api.canEmitPlaybackSessionSideEffects(), false);

  await api.start(tracks[0]);
  assert.equal(api.canEmitPlaybackSessionSideEffects(), true);
  bridge.event('playback.ownership', { ...state(1, 'loading'), ownership: 'owned' });
  bridge.event('playback.state', state(1, 'playing', 250));
  await api.pause();
  bridge.event('playback.state', state(1, 'paused', 900));
  // The paused checkpoint still goes out under the claim Android keeps until the web releases it.
  assert.equal(api.canEmitPlaybackSessionSideEffects(), true);

  assert.equal(await api.releasePlaybackOwnership(), true);
  assert.equal(commands(bridge, 'playback.releaseOwnership').length, 1);
  bridge.event('playback.ownership', { ...state(1, 'paused', 900), ownership: 'released' });
  assert.equal(api.canEmitPlaybackSessionSideEffects(), false);

  assert.equal(await api.resume(), true);
  assert.equal(api.canEmitPlaybackSessionSideEffects(), true);
  assert.equal(await api.releasePlaybackOwnership(), false);
  bridge.event('playback.ownership', { ...state(1, 'paused'), ownership: 'blocked' });
  assert.equal(api.canEmitPlaybackSessionSideEffects(), false);
});

test('release waits for listen writes already sent under the native claim', async () => {
  let finish;
  const { api, bridge } = createHarness({
    listen: true,
    respond: message => (message.name === 'playback.listenEffect'
      ? new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, data: { ok: true } }); })
      : null),
  });
  await api.start(tracks[0]);
  await api.pause();
  const write = api.postPlaybackSession('/playback/session/complete', { title: 'Signal A' });
  const release = api.releasePlaybackOwnership();
  await settle();
  assert.equal(commands(bridge, 'playback.releaseOwnership').length, 0);
  finish();
  await write;
  assert.equal(await release, true);
  assert.equal(commands(bridge, 'playback.releaseOwnership').length, 1);
});

test('native heard frames feed the web listen measurement once per item and underruns break contiguity', async () => {
  const { api, bridge, context } = createHarness();
  const recorded = [];
  const breaks = [];
  context.recordMeasuredStreamingFrames = (role, message, sampleRate) => {
    role.measuredListenSession ||= { track: role.track.path };
    recorded.push([role.track.title, message.frames, sampleRate]);
  };
  context.breakMeasuredListenSegment = session => breaks.push(session?.track);
  await api.start(tracks[0]);

  const measured = (positionMs, renderedFrames, underruns = 0, index = 0) => ({
    ...state(1, 'playing', positionMs, index), renderedFrames, sampleRate: 48000, underruns,
  });
  bridge.event('playback.state', measured(0, 0));
  bridge.event('playback.position', measured(1000, 48000));
  bridge.event('playback.position', measured(1000, 48000));
  bridge.event('playback.position', measured(2000, 96000, 1));
  bridge.event('playback.currentItem', { ...measured(0, 0, 0, 1), reason: 'advance', outgoingRenderedFrames: 100000 });
  bridge.event('playback.position', measured(500, 24000, 0, 1));

  assert.deepEqual(recorded, [
    ['Signal A', 48000, 48000], ['Signal A', 48000, 48000], ['Signal A', 4000, 48000], ['Signal B', 24000, 48000],
  ]);
  assert.deepEqual(breaks, [tracks[0].path]);
});

test('the native queue continues into the next album where the web queue would', async () => {
  const nextAlbum = ['Signal D', 'Signal E'].map((title, index) => ({
    ...tracks[0], path: `C:/Music/Android Acceptance/Second/0${index + 1} ${title}.flac`, title, album: 'Second',
  }));
  const { api, bridge, context } = createHarness();
  context.state.player.playbackQueue = { tracks, currentIndex: 0, albumRef: 'first' };
  context.resolveNextPlaybackContextQueue = queue => (queue.albumRef === 'first'
    ? { tracks: nextAlbum, currentIndex: 0, albumRef: 'second' }
    : { tracks: tracks.slice(0, 1), currentIndex: 0, albumRef: 'first' });
  await api.start(tracks[1]);

  const [load] = commands(bridge, 'playback.loadQueue');
  assert.deepEqual(load.payload.items.map(item => item.title), ['Signal B', 'Signal C', 'Signal D', 'Signal E']);
  assert.equal(api.native.items.at(-1), nextAlbum[1]);
  // The first track of the next album is already Android's successor, so nothing reloads.
  bridge.event('playback.state', state(1, 'playing', 1000, 0));
  await api.continuity(tracks[2]);
  assert.equal(commands(bridge, 'playback.loadQueue').length, 1);
});

test('held references are reused and an expired one is fetched again', async () => {
  const { api, bridge, fetches } = createHarness();
  await api.start(tracks[0]);
  await api.start(tracks[1]);
  assert.equal(fetches.length, 1);
  const loads = commands(bridge, 'playback.loadQueue');
  assert.deepEqual(loads[1].payload.items.map(item => item.playbackRef), ['opaque-ref-1', 'opaque-ref-2']);

  bridge.event('playback.referenceExpired', state(2, 'error', 0, 0));
  await settle();
  assert.equal(fetches.length, 2);
  assert.deepEqual(fetches[1].body.tracks.map(track => track.path), [tracks[1].path, tracks[2].path]);
});

test('a successor the rebuilt queue cannot reach never reloads Android', async () => {
  const { api, bridge, context } = createHarness();
  await api.start(tracks[0]);
  bridge.event('playback.state', state(1, 'playing', 30000));
  context.state.player.playbackQueue = { tracks: [tracks[0]], currentIndex: 0 };

  const role = await api.continuity(tracks[2]);
  assert.equal(role.track, tracks[0]);
  assert.equal(commands(bridge, 'playback.loadQueue').length, 1);
});

test('a closing document hands its listen checkpoint to Android instead of a beacon', async () => {
  const { api, bridge, context } = createHarness({ listen: true });
  Object.assign(context, {
    isoNow: () => '2026-11-02T20:00:00.000Z',
    unixNowSeconds: () => 1793649600,
    getPlayerPlaybackSnapshot: () => ({ currentTime: 42, duration: 180, paused: false, ended: false }),
    navigator: { sendBeacon: () => { throw new Error('the APK has no handoff beacon'); } },
  });
  await api.start(tracks[0]);
  vm.runInContext(`state.player.current = ${JSON.stringify(tracks[0])};
    startListenSession(state.player.current);
    Object.assign(state.player.listenSession.measurement, { total: 40, longest: 40 });
    beginListenSegment(2);`, context);

  assert.equal(vm.runInContext("flushListenSessionOnUnload('pagehide')", context), true);
  await settle();
  const [effect] = commands(bridge, 'playback.listenEffect');
  assert.equal(effect.payload.effect, 'complete');
  assert.equal(effect.payload.body.completion_reason, 'pagehide');
  assert.equal(effect.payload.body.finalized, true);
  assert.equal(effect.payload.body.measured_listened_seconds, 40);
  assert.ok(!('claimToken' in effect.payload.body));
});
