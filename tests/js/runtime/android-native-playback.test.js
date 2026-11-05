const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadCapabilityUi } = require('../support/capability-ui-context.cjs');

const repoRoot = path.join(__dirname, '..', '..', '..');
const runtimeDir = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime');
const fixture = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'android-bridge', 'v1.json'), 'utf8'));
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
        tracks: body.tracks.map((track, index) => ({
          clientKey: track.clientKey, playbackRef: `opaque-ref-${index}`, resumeToken: `opaque-resume-${index}`,
        })),
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
  loadCapabilityUi(context);
  // The listen helpers name the track identity a queue item's listen key is derived from.
  const files = ['player-streaming-engine.js', 'android-bridge-client.js', 'player-listen-session-helpers.js',
    ...(listen ? ['playback-ownership-helpers.js'] : [])];
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
  // Each item names its path-free resume token and the artwork the server resolves for it.
  assert.deepEqual(load.payload.items.map(item => [item.resumeToken, item.artworkUrl]), [0, 1, 2].map(index => [
    `opaque-resume-${index}`, `/playback/artwork/opaque-resume-${index}`]));
  assert.equal(load.payload.queueRevision, 1);
  assert.equal(load.payload.positionMs, 1500);
  assert.equal(load.payload.autoplay, true);
  assert.equal(load.payload.items[0].durationMs, 180000);
  assert.ok(bridge.sent.every(message => !JSON.stringify(message).includes('C:/Music')));
  assert.equal(role.track, tracks[0]);
  assert.equal(api.snapshot().diagnostics.native, true);
  assert.equal(api.getAndroidNativePlaybackClientId(), handshakePayload.playback.clientId);
});

test('resume tokens reach only a resumption-capable shell and artwork needs a valid token', async () => {
  const withoutResumption = {
    ...handshakePayload,
    capabilities: handshakePayload.capabilities.filter(name => name !== 'playback.resumption.v1'),
  };
  const older = createHarness({ respond: message => (message.name === 'bridge.handshake' ? withoutResumption : null) });
  await older.api.start(tracks[0]);
  const [olderLoad] = commands(older.bridge, 'playback.loadQueue');
  assert.ok(olderLoad.payload.items.every(item => !('resumeToken' in item)));
  assert.equal(olderLoad.payload.items[0].artworkUrl, '/playback/artwork/opaque-resume-0');

  const invalid = createHarness({
    refs: body => ({
      protocol: 1,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      tracks: body.tracks.map((track, index) => ({
        clientKey: track.clientKey, playbackRef: `opaque-ref-${index}`,
        ...(index === 0 ? {} : { resumeToken: index === 1 ? '../cover?path=C:/Music' : 7 }),
      })),
    }),
  });
  await invalid.api.start(tracks[0]);
  const [load] = commands(invalid.bridge, 'playback.loadQueue');
  assert.deepEqual(load.payload.items.map(item => [item.artworkUrl, 'resumeToken' in item]), [
    [null, false], [null, false], [null, false]]);
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
  assert.equal(loads[0].payload.items.length, 3);
  assert.equal(loads[0].payload.currentIndex, 1);
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
    [{ queueRevision: 1, startFrame: 480000, endFrame: 960000, kind: 'long-loop' }]);
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
  // Android keeps playing the same item; only the queue around it changes.
  assert.equal(loads[1].payload.keepCurrent, true);
  assert.equal(api.native.index, 0);
  assert.equal(api.snapshot().currentTime, 30);
});

test('inside a native shell the web builds and sends no listen write and never releases the claim', async () => {
  const { api, bridge, fetches, context } = createHarness({ listen: true });
  await api.start(tracks[0]);
  bridge.event('playback.ownership', { ...state(1, 'loading'), ownership: 'owned' });
  bridge.event('playback.state', state(1, 'playing', 250));
  vm.runInContext(`state.player.current = ${JSON.stringify(tracks[0])};
    startListenSession(state.player.current);`, context);
  assert.equal(context.state.player.listenSession, null);
  assert.equal(await vm.runInContext(`maybeSendNowPlaying(${JSON.stringify(tracks[0])}, null)`, context), false);
  assert.equal(api.canEmitPlaybackSessionSideEffects(), true);

  await api.pause();
  bridge.event('playback.state', state(1, 'paused', 900));
  assert.equal(await api.releasePlaybackOwnership(), false);
  assert.equal(vm.runInContext("flushListenSessionOnUnload('pagehide', getStreamingPlaybackSnapshot())", context), false);
  await settle();

  assert.deepEqual(bridge.sent.map(message => message.name).filter(name => /listen|releaseOwnership/i.test(name)), []);
  assert.ok(fetches.every(request => !request.url.startsWith('/playback/session')));
  assert.equal(JSON.stringify(api.getPlaybackClaimContext()), '{}');
  bridge.event('playback.ownership', { ...state(1, 'paused'), ownership: 'blocked' });
  assert.equal(api.canEmitPlaybackSessionSideEffects(), false);
});

test('each queued item carries the track number Android names its listen writes with', async () => {
  const { api, bridge } = createHarness();
  await api.start({ ...tracks[0], trackNumber: '01' });
  const [load] = commands(bridge, 'playback.loadQueue');
  assert.deepEqual(load.payload.items.map(item => item.trackNumber), ['01', '', '']);
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
  assert.deepEqual(load.payload.items.map(item => item.title),
    ['Signal A', 'Signal B', 'Signal C', 'Signal D', 'Signal E']);
  // Each album is one queue group, so Android's previous and next stay inside it.
  assert.deepEqual(load.payload.items.map(item => item.queueGroup), [0, 0, 0, 1, 1]);
  assert.equal(load.payload.currentIndex, 1);
  assert.equal(api.native.index, 1);
  assert.equal(api.native.items.at(-1), nextAlbum[1]);
  // The first track of the next album is already Android's successor, so nothing reloads.
  bridge.event('playback.state', state(1, 'playing', 1000, 1));
  await api.continuity(tracks[2]);
  assert.equal(commands(bridge, 'playback.loadQueue').length, 1);
});

test('the native queue starts at the album\'s first track so Android\'s previous reaches it', async () => {
  const { api, bridge, context } = createHarness();
  await api.start(tracks[2]);
  const [load] = commands(bridge, 'playback.loadQueue');
  assert.deepEqual(load.payload.items.map(item => item.title), ['Signal A', 'Signal B', 'Signal C']);
  assert.equal(load.payload.currentIndex, 2);
  assert.equal(load.payload.positionMs, 0);

  // A long album sheds earlier tracks before following ones to fit the message budget, never the current item.
  const album = Array.from({ length: 100 }, (_, index) => ({
    ...tracks[0], path: `C:/Music/Long/${index}.flac`, title: 'x'.repeat(500), artist: 'y'.repeat(500),
  }));
  context.state.player.playbackQueue = { tracks: album, currentIndex: 90 };
  await api.start(album[90]);
  const long = commands(bridge, 'playback.loadQueue').at(-1).payload;
  assert.ok(new TextEncoder().encode(JSON.stringify(long)).length <= 60 * 1024);
  assert.equal(long.items[long.currentIndex].title, album[90].title);
  assert.equal(api.native.items[api.native.index], album[90]);
  assert.equal(long.items.length - 1, long.currentIndex + 9);
  assert.ok(long.currentIndex > 0 && long.currentIndex < 90);
  assert.equal(api.native.items.length, long.items.length);
});

test('a loop names the web\'s kind so Android replays a short loop from retained PCM', async () => {
  const { api, bridge } = createHarness();
  await api.start(tracks[0]);
  bridge.event('playback.state', state(1, 'playing'));
  await api.continuity(tracks[0], { kind: 'short-loop', startSeconds: 1.3, endSeconds: 6.3 });
  assert.deepEqual(commands(bridge, 'playback.setLoop').map(message => message.payload),
    [{ queueRevision: 1, startFrame: 62400, endFrame: 302400, kind: 'short-loop' }]);
});

test('held references are reused and an expired one is fetched again', async () => {
  const { api, bridge, fetches } = createHarness();
  await api.start(tracks[0]);
  await api.start(tracks[1]);
  assert.equal(fetches.length, 1);
  const loads = commands(bridge, 'playback.loadQueue');
  assert.deepEqual(loads[1].payload.items.map(item => item.playbackRef), ['opaque-ref-0', 'opaque-ref-1', 'opaque-ref-2']);

  bridge.event('playback.referenceExpired', state(2, 'error', 0, 1));
  await settle();
  assert.equal(fetches.length, 2);
  assert.deepEqual(fetches[1].body.tracks.map(track => track.path), tracks.map(track => track.path));
});

test('a refreshed reference keeps the opaque listen key Android tells one listen by', async () => {
  const { api, bridge } = createHarness();
  await api.start(tracks[0]);
  bridge.event('playback.referenceExpired', state(1, 'error', 0, 0));
  await settle();

  const [first, retried] = commands(bridge, 'playback.loadQueue');
  const keys = first.payload.items.map(item => item.listenKey);
  assert.deepEqual(retried.payload.items.map(item => item.listenKey), keys);
  assert.equal(new Set(keys).size, tracks.length);
  assert.ok(keys.every(key => /^lk1-[0-9a-f]{16}$/.test(key)));
  // A different source of the same path is another track, as the web's own track identity says.
  await api.start({ ...tracks[0], src: '/track?id=other' });
  assert.notEqual(commands(bridge, 'playback.loadQueue').at(-1).payload.items[0].listenKey, keys[0]);
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

function withPlayer(context) {
  const storage = new Map();
  const player = { tracks: [], sessions: [], pauses: [], toggles: [], persisted: 0 };
  Object.assign(context, {
    getLocalStorageItem: key => storage.get(key) || '',
    setLocalStorageItem: (key, value) => { storage.set(key, value); return true; },
    setCurrentPlayerTrack: (track, options) => player.tracks.push([track.path, options]),
    beginStreamingPlayerListenSession: (track, startSeconds) => player.sessions.push([track.path, startSeconds]),
    pausePlayerPlaybackForHandoff: snapshot => { player.pauses.push(snapshot); return context.pauseStreamingPlayback(); },
    togglePlayerPlayback: options => player.toggles.push(options),
    persistPlayerState: () => { player.persisted += 1; },
  });
  return { storage, player };
}

function liveHandshake(playback) {
  return message => (message.name === 'bridge.handshake'
    ? { ...handshakePayload, playback: { ...handshakePayload.playback, ...playback } }
    : null);
}

test('a loaded queue is remembered for the next document of the origin', async () => {
  const { api, context } = createHarness();
  const { storage } = withPlayer(context);
  await api.start(tracks[1]);
  const record = JSON.parse(storage.get('albumhaven.androidNativeQueue.v1'));
  assert.equal(record.clientId, handshakePayload.playback.clientId);
  assert.equal(record.queueRevision, 1);
  assert.deepEqual(record.tracks.map(track => track.path), tracks.map(track => track.path));
});

test('a reloaded document re-attaches its UI to the queue Android kept playing', async () => {
  const live = { state: 'playing', queueRevision: 7, currentIndex: 1, positionMs: 61500, durationMs: 180000 };
  const { api, bridge, fetches, context } = createHarness({ respond: liveHandshake(live) });
  const { storage, player } = withPlayer(context);
  storage.set('albumhaven.androidNativeQueue.v1', JSON.stringify({
    clientId: handshakePayload.playback.clientId, queueRevision: 7, tracks,
  }));

  assert.equal(await vm.runInContext('attachAndroidNativePlayback({})', context), true);
  assert.equal(commands(bridge, 'playback.loadQueue').length, 0);
  assert.equal(fetches.length, 0);
  assert.deepEqual(player.tracks.map(([trackPath]) => trackPath), [tracks[1].path]);
  // Android's listen of the playing item continues; the document starts none.
  assert.deepEqual(player.sessions, []);
  assert.deepEqual(commands(bridge, 'playback.clearLoop').map(message => message.payload), [{ queueRevision: 7 }]);
  assert.equal(api.snapshot().paused, false);
  assert.equal(api.snapshot().currentTime, 61.5);
  assert.equal(api.snapshot().mode, 'playing');
  await api.pause();
  assert.deepEqual(commands(bridge, 'playback.pause').map(message => message.payload), [{}]);
  assert.equal(await api.resume(), true);
  assert.deepEqual(commands(bridge, 'playback.play').map(message => message.payload), [{ queueRevision: 7 }]);
  await api.start(tracks[0]);
  assert.equal(commands(bridge, 'playback.loadQueue')[0].payload.queueRevision, 8);
});

test('a queue another client or revision applied is never adopted', async () => {
  for (const record of [
    { clientId: 'b3c1e2d4-0000-4000-8000-000000000000', queueRevision: 7 },
    { clientId: handshakePayload.playback.clientId, queueRevision: 6 },
  ]) {
    const { bridge, context } = createHarness({
      respond: liveHandshake({ state: 'playing', queueRevision: 7, currentIndex: 0, positionMs: 1000 }),
    });
    const { storage, player } = withPlayer(context);
    storage.set('albumhaven.androidNativeQueue.v1', JSON.stringify({ ...record, tracks }));
    assert.equal(await vm.runInContext('attachAndroidNativePlayback({})', context), false);
    assert.equal(player.tracks.length, 0);
    assert.equal(bridge.sent.filter(message => message.name !== 'bridge.handshake').length, 0);
  }
  const { context } = createHarness({ respond: liveHandshake({ state: 'idle', queueRevision: 7, currentIndex: 0 }) });
  const { storage } = withPlayer(context);
  storage.set('albumhaven.androidNativeQueue.v1', JSON.stringify({
    clientId: handshakePayload.playback.clientId, queueRevision: 7, tracks,
  }));
  assert.equal(await vm.runInContext('attachAndroidNativePlayback({})', context), false);
  assert.equal(vm.runInContext('attachAndroidNativePlayback({})', createHarness({ shell: false }).context), null);
});

test('pauses and resumes from Android controls run the web pause and resume paths once', async () => {
  const { api, bridge, context } = createHarness();
  const { player } = withPlayer(context);
  await api.start(tracks[0]);
  bridge.event('playback.state', state(1, 'playing', 1000));

  bridge.event('playback.state', { ...state(1, 'paused', 4000), initiator: 'system' });
  assert.equal(player.pauses.length, 1);
  assert.equal(player.pauses[0].paused, false);
  assert.equal(player.pauses[0].currentTime, 4);
  assert.equal(api.snapshot().paused, true);
  bridge.event('playback.state', { ...state(1, 'paused', 4000), initiator: 'system' });
  assert.equal(player.pauses.length, 1);

  bridge.event('playback.state', { ...state(1, 'loading', 4000), initiator: 'system' });
  assert.equal(JSON.stringify(player.toggles), '[{"focusTimelineOnResume":false}]');
  assert.equal(api.snapshot().paused, false);
  // The web's own pause is already applied when Android reports it.
  await api.pause();
  bridge.event('playback.state', state(1, 'paused', 5000));
  assert.equal(player.pauses.length, 1);
});

test('a skip from Android controls selects the item Android moved to', async () => {
  const { api, bridge, context } = createHarness();
  const { player } = withPlayer(context);
  context.peekNextQueuedTrack = () => tracks[1];
  let advanced = 0;
  context.getNextQueuedTrack = () => { advanced += 1; return tracks[1]; };
  await api.start(tracks[0]);
  bridge.event('playback.state', state(1, 'playing', 1000));

  bridge.event('playback.currentItem', { ...state(1, 'playing', 0, 1), reason: 'next', initiator: 'system' });
  assert.equal(advanced, 1);
  assert.deepEqual(player.tracks.map(([trackPath]) => trackPath), [tracks[1].path]);
  assert.equal(player.tracks[0][1].previousPlaybackSnapshot.currentTime, 1);
  assert.deepEqual(player.sessions, []);
  assert.equal(api.native.index, 1);
  assert.equal(commands(bridge, 'playback.loadQueue').length, 1);

  bridge.event('playback.currentItem', { ...state(1, 'playing', 0, 0), reason: 'previous', initiator: 'system' });
  assert.deepEqual(player.tracks.map(([trackPath]) => trackPath), [tracks[1].path, tracks[0].path]);
  assert.equal(context.state.player.playbackQueue.currentIndex, 0);
  // The web's own skips load a queue, so their echoes change nothing.
  bridge.event('playback.currentItem', { ...state(1, 'playing', 0, 1), reason: 'next' });
  assert.equal(player.tracks.length, 2);
});
test('a closing document leaves playback to the media session that outlives it', async () => {
  const { api, bridge } = createHarness();
  await api.start(tracks[0]);
  bridge.event('playback.state', state(1, 'playing', 1000));
  await api.stop('unload');
  assert.equal(commands(bridge, 'playback.stop').length, 0);
  assert.equal(api.snapshot().paused, false);
  await api.stop('stopped');
  assert.equal(commands(bridge, 'playback.stop').length, 1);
});
test('an ownership read inside the APK waits for the handshake that names the native client', async () => {
  const { context } = createHarness({ listen: true });
  const urls = [];
  context.AbortController = AbortController;
  context.fetch = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ is_playing_elsewhere: false }) };
  };
  await vm.runInContext('handlePlaybackOwnershipEvent()', context);
  assert.deepEqual(urls, [`/playback/state?client_id=${handshakePayload.playback.clientId}`]);
});

test('a playback claim inside the APK waits for the handshake that names the native player', async () => {
  const { context } = createHarness({ listen: true });
  const urls = [];
  context.AbortController = AbortController;
  context.fetch = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ is_playing_elsewhere: false }) };
  };
  const claim = `claimPlaybackOwnership(${JSON.stringify(tracks[0])}, { showBlockedToast: false })`;
  assert.equal(await vm.runInContext(claim, context), true);
  assert.notEqual(vm.runInContext('getPlaybackOwnershipState().lockStatus', context), 'locked');
  assert.deepEqual(urls, [], 'Android claims for itself; the web never asks');
});

test('events the stopped queue still emits never revive playback or ownership', async () => {
  const { api, bridge } = createHarness();
  await api.start(tracks[0]);
  bridge.event('playback.state', state(1, 'playing', 1000));
  await api.stop('stopped');
  // Android releases its claim with the stop.
  assert.equal(api.native.ownership, 'none');

  bridge.event('playback.state', state(1, 'playing', 2000));
  bridge.event('playback.ownership', { ...state(1, 'playing'), ownership: 'owned' });
  assert.equal(api.snapshot().paused, true);
  assert.equal(api.snapshot().mode, 'stopped');
  assert.equal(api.snapshot().currentTime, 0);
  assert.equal(api.native.ownership, 'none');
  assert.equal(api.snapshot().diagnostics.queueRevision, 0);
});

test('a stop while the first queue load is pending stops what Android loads', async () => {
  let releaseLoad;
  const held = new Promise(resolve => { releaseLoad = resolve; });
  // The shell applies commands in the order they arrive; only the load's answer is delayed.
  let audible = false;
  const { api, bridge } = createHarness({
    respond: (message) => {
      if (message.name === 'playback.loadQueue') {
        audible = message.payload.autoplay;
        return held.then(() => ({ ok: true, queueRevision: message.payload.queueRevision }));
      }
      if (message.name === 'playback.stop') audible = false;
      return null;
    },
  });
  await api.connectAndroidBridge();
  const starting = api.start(tracks[0], { autoplay: true });
  while (!commands(bridge, 'playback.loadQueue').length) await settle();
  await api.stop('stopped');
  assert.deepEqual(bridge.sent.slice(1).map(message => message.name), ['playback.loadQueue', 'playback.stop']);
  releaseLoad();
  assert.equal(await starting, null);
  await settle();

  assert.equal(audible, false, 'Android plays nothing the web shows stopped');
  assert.equal(api.snapshot().mode, 'stopped');
  assert.equal(api.snapshot().diagnostics.queueRevision, 0);
  assert.equal(api.native.ownerIntent, false);
  bridge.event('playback.state', state(1, 'playing', 1000));
  assert.equal(api.snapshot().paused, true);
});

test('a stop after a superseded queue load lands still stops what Android loads', async () => {
  let releaseLoad;
  let releaseRefs;
  const heldLoad = new Promise(resolve => { releaseLoad = resolve; });
  const heldRefs = new Promise(resolve => { releaseRefs = resolve; });
  let audible = false;
  const { api, bridge, fetches } = createHarness({
    refs: (body) => {
      const issued = { protocol: 1, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        tracks: body.tracks.map((track, index) => ({ clientKey: track.clientKey, playbackRef: `opaque-ref-${index}` })) };
      return fetches.length === 1 ? issued : heldRefs.then(() => issued);
    },
    respond: (message) => {
      if (message.name === 'playback.loadQueue') {
        audible = message.payload.autoplay;
        return heldLoad.then(() => ({ ok: true, queueRevision: message.payload.queueRevision }));
      }
      if (message.name === 'playback.stop') audible = false;
      return null;
    },
  });
  await api.connectAndroidBridge();
  const first = api.start(tracks[0], { autoplay: true });
  while (!commands(bridge, 'playback.loadQueue').length) await settle();
  // The second pick's references are not held yet, so it waits on them while the first load lands.
  const second = api.start({ ...tracks[1], path: 'C:/Music/Elsewhere/01 Signal D.flac' }, { autoplay: true });
  while (fetches.length < 2) await settle();
  releaseLoad();
  assert.equal(await first, null);
  await api.stop('stopped');
  releaseRefs();
  assert.equal(await second, null);
  await settle();

  assert.deepEqual(bridge.sent.slice(1).map(message => message.name), ['playback.loadQueue', 'playback.stop']);
  assert.equal(audible, false, 'Android plays nothing the web shows stopped');
});

// X plays; the switch to Y waits on its references, or on its posted load when `holdLoad` is set.
async function pauseDuringSwitch({ holdLoad }) {
  let releaseRefs;
  let releaseLoad;
  const heldRefs = new Promise(resolve => { releaseRefs = resolve; });
  const heldLoad = new Promise(resolve => { releaseLoad = resolve; });
  let audible = false;
  const { api, bridge, fetches } = createHarness({
    refs: (body) => {
      const issued = { protocol: 1, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        tracks: body.tracks.map((track, index) => ({ clientKey: track.clientKey, playbackRef: `opaque-ref-${index}` })) };
      return fetches.length === 1 || holdLoad ? issued : heldRefs.then(() => issued);
    },
    respond: (message) => {
      if (message.name === 'playback.loadQueue') {
        audible = message.payload.autoplay;
        if (message.payload.queueRevision === 2 && holdLoad) {
          return heldLoad.then(() => ({ ok: true, queueRevision: 2 }));
        }
      }
      if (message.name === 'playback.pause' || message.name === 'playback.stop') audible = false;
      return null;
    },
  });
  await api.start(tracks[0], { autoplay: true });
  bridge.event('playback.state', state(1, 'playing', 30000));
  const switching = api.start({ ...tracks[1], path: 'C:/Music/Elsewhere/01 Signal D.flac' }, { autoplay: true });
  if (holdLoad) {
    while (commands(bridge, 'playback.loadQueue').length < 2) await settle();
  } else {
    while (fetches.length < 2) await settle();
  }
  await api.pause();
  releaseRefs();
  releaseLoad();
  assert.equal(await switching, null);
  await settle();

  assert.equal(audible, false, 'Android plays nothing while the web shows a pause');
  assert.equal(api.snapshot().paused, true);
  assert.equal(api.snapshot().mode, 'stopped');
  assert.equal(api.snapshot().currentTime, 30, 'the next play restarts the shown track where it paused');
  return bridge.sent.slice(1).map(message => message.name);
}

test('a pause while a track switch waits on references supersedes the switch', async () => {
  assert.deepEqual(await pauseDuringSwitch({ holdLoad: false }), ['playback.loadQueue', 'playback.stop']);
});

test('a pause after a track switch posted its load stops what Android loads', async () => {
  assert.deepEqual(await pauseDuringSwitch({ holdLoad: true }),
    ['playback.loadQueue', 'playback.loadQueue', 'playback.stop']);
});

test('a pause while a queue replacement waits on references keeps Android paused', async () => {
  let releaseRefs;
  const heldRefs = new Promise(resolve => { releaseRefs = resolve; });
  const { api, bridge, context, fetches } = createHarness({
    refs: (body) => {
      const issued = { protocol: 1, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        tracks: body.tracks.map((track, index) => ({ clientKey: track.clientKey, playbackRef: `opaque-ref-${index}` })) };
      return fetches.length === 1 ? issued : heldRefs.then(() => issued);
    },
  });
  await api.start(tracks[0], { autoplay: true });
  bridge.event('playback.state', state(1, 'playing', 30000));
  const successor = { ...tracks[2], path: 'C:/Music/Elsewhere/03 Signal E.flac' };
  context.state.player.playbackQueue = { tracks: [tracks[0], successor], currentIndex: 0 };
  const replacing = api.continuity(successor);
  while (fetches.length < 2) await settle();
  await api.pause();
  releaseRefs();
  assert.notEqual(await replacing, null);

  const loads = commands(bridge, 'playback.loadQueue');
  assert.equal(loads.length, 2);
  assert.equal(loads[1].payload.keepCurrent, true);
  assert.equal(loads[1].payload.autoplay, false);
  assert.equal(api.snapshot().paused, true);
});

test('a start whose references or queue load fail leaves Android no owner intent', async () => {
  const refused = createHarness({ refs: () => ({ protocol: 1, tracks: [] }) });
  await assert.rejects(refused.api.start(tracks[0]), /Playback references are unavailable/);
  assert.equal(refused.api.native.ownerIntent, false);

  const rejected = createHarness({
    respond: message => (message.name === 'playback.loadQueue'
      ? { ok: false, error: { code: 'invalid_queue', message: 'Refused' } } : null),
  });
  await assert.rejects(rejected.api.start(tracks[0]), /Refused/);
  assert.equal(rejected.api.native.ownerIntent, false);
});

test('a refused resume leaves Android no owner intent', async () => {
  const { api, bridge } = createHarness({
    respond: message => (message.name === 'playback.play'
      ? { ok: false, error: { code: 'invalid_state', message: 'Refused' } } : null),
  });
  await api.start(tracks[0], { autoplay: false });
  bridge.event('playback.state', state(1, 'paused'));
  await assert.rejects(api.resume(), /Refused/);
  assert.equal(api.native.ownerIntent, false);
});

test('a reference that expires again after a recovered one is refreshed again', async () => {
  const { api, bridge, fetches } = createHarness();
  await api.start(tracks[0]);
  bridge.event('playback.referenceExpired', state(1, 'error', 0, 0));
  await settle();
  assert.equal(fetches.length, 2);
  bridge.event('playback.state', state(2, 'playing', 5000));

  bridge.event('playback.referenceExpired', state(2, 'error', 0, 0));
  await settle();
  assert.equal(fetches.length, 3);
  assert.equal(api.snapshot().mode, 'starting');
  // A refreshed reference that expires before it plays is a real failure.
  bridge.event('playback.referenceExpired', state(3, 'error', 0, 0));
  assert.equal(api.snapshot().mode, 'error');
});