const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'player-state-persistence-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');
const fixturePlatforms = new WeakMap();

function loadUnloadHelper(t, overrides, { initializeOwnership = true } = {}) {
  const listener = require('./search-native-fixtures/listener-search.cjs');
  const { world } = require('./search-native-fixtures/ownership-platform.cjs');
  const finiteWorld = world();
  const platform = finiteWorld.createTab();
  const h = listener.fixture(t, { beforeRuntimePlatform: platform.install });
  platform.installAudio();
  t.after(() => platform.dispose());
  const context = h.c;
  fixturePlatforms.set(context, { platform, world: finiteWorld });
  context.state = h.state;
  assert.strictEqual(context.state, h.owner('state'));
  assert.strictEqual(context.state.player, h.owner('state.player'));
  assert.equal(context.state.player instanceof context.Element, false);
  Object.assign(h.state.player, overrides.state.player);
  context.updatePlayerUi = () => {};
  for (const name of ['getPlayerPlaybackSnapshot', 'setLocalStorageItem', 'flushListenSessionOnUnload']) {
    if (Object.hasOwn(overrides, name)) context[name] = overrides[name];
  }
  if (initializeOwnership) {
    context.initPlaybackOwnershipCoordinator();
    assert.equal(context.isPlaybackOwnershipScopeCurrent(context.capturePlaybackOwnershipScope()), true);
  } else {
    assert.equal(context.state.player.ownership.initialized, false);
    assert.equal(context.state.player.ownership.channel, null);
    assert.equal(context.state.player.streaming.context, null);
    assert.equal(context.state.player.streaming.roles.current, null);
  }
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  return context;
}

function loadRestoreAdmissionHelper(t, overrides, { paused = true } = {}) {
  const cleanups = [];
  let context;
  const observed = { handle: null, bindings: [], attempt: null, role: null, error: null, settled: false, writes: [] };
  t.after(async () => {
    const failures = [];
    try {
      if (context) {
        try {
          const restore = vm.runInContext('playerRestoreAttempt', context);
          if (restore) {
            assert.strictEqual(restore.handle, observed.handle);
            assert.strictEqual(restore.engineAttempt, observed.attempt);
            context.retirePlayerRestoreAttempt('test-teardown');
          }
        } catch (error) { failures.push(error); }
        try {
          if (observed.handle) {
            context.releasePlaybackOwnership('stopped', observed.handle);
          }
        } catch (error) { failures.push(error); }
        const pendingStop = context.streamingEngineState().stopPromise;
        if (pendingStop) await pendingStop;
        else if (observed.attempt) await context.stopStreamingPlayback('test-teardown', { expectedAttempt: observed.attempt });
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (context && observed.handle) {
          assert.notStrictEqual(context.getActivePlaybackOwnershipHandle(), observed.handle);
          const raw = context.getLocalStorageItem('albumhaven.playbackOwnership.v1');
          const lease = raw ? JSON.parse(raw) : null;
          assert.equal(Boolean(lease && lease.tab_id === observed.handle.tab_id
            && lease.claim_revision === observed.handle.claim_revision), false,
          'cleanup cannot leave the captured restore lease in storage');
        }
      } catch (error) { failures.push(error); }
      try { context?.disposePlaybackOwnershipCoordinator(); } catch (error) { failures.push(error); }
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Restore fixture cleanup failed');
  });
  context = loadUnloadHelper({ after(cleanup) { cleanups.push(cleanup); } }, { state: overrides.state });
  const storageKey = 'albumhaven.playerState.v1';
  context.setLocalStorageItem(storageKey, overrides.getLocalStorageItem());
  context.resolveAlbumForPlayerTrack = overrides.resolveAlbumForPlayerTrack || (() => null);
  const write = context.setLocalStorageItem;
  context.setLocalStorageItem = (key, value) => {
    if (key === storageKey) observed.writes.push(value);
    return write(key, value);
  };
  const canRestore = context.canRestoreActivePlayback;
  context.canRestoreActivePlayback = (...args) => {
    const handle = canRestore(...args);
    observed.handle = handle;
    return handle;
  };
  const bindAttempt = context.bindPlaybackOwnershipAttempt;
  context.bindPlaybackOwnershipAttempt = (handle, attempt) => {
    const result = bindAttempt(handle, attempt);
    observed.bindings.push({ handle, attempt, result });
    return result;
  };
  const start = context.startStreamingTrack;
  context.startStreamingTrack = (track, options) => {
    const onStartAttempt = options.onStartAttempt;
    const work = start(track, { ...options, onStartAttempt(attempt) {
      observed.attempt = attempt;
      onStartAttempt(attempt);
    } });
    void work.then(role => { observed.role = role; observed.settled = true; },
      error => { observed.error = error; observed.settled = true; });
    return work;
  };
  function assertAdmission(path, offset) {
    assert.equal(observed.error, null);
    assert.equal(observed.settled, true);
    assert.ok(observed.role);
    assert.ok(observed.attempt);
    assert.equal(context.isStreamingPlaybackAttemptCurrent(observed.attempt), true);
    assert.strictEqual(context.streamingEngineState().roles.current, observed.role);
    assert.equal(observed.role.track.path, path);
    assert.equal(context.state.player.current.path, path);
    assert.equal(context.getPlayerPlaybackSnapshot().paused, paused);
    assert.equal(context.getPlayerPlaybackSnapshot().currentTime, offset);
    assert.equal(context.state.player.lastRestoreError, undefined);
    if (paused) {
      assert.equal(context.getActivePlaybackOwnershipHandle(), null);
      assert.equal(observed.writes.length, 1, 'paused restore writes the saved-state key once');
    } else {
      assert.ok(observed.handle);
      assert.strictEqual(context.getActivePlaybackOwnershipHandle(), observed.handle);
      assert.equal(context.isPlaybackOwnershipHandleCurrent(observed.handle), true);
      assert.equal(observed.bindings.length, 1);
      assert.strictEqual(observed.bindings[0].handle, observed.handle);
      assert.strictEqual(observed.bindings[0].attempt, observed.attempt);
      assert.equal(observed.bindings[0].result, true);
      const restore = vm.runInContext('playerRestoreAttempt', context);
      assert.strictEqual(restore.handle, observed.handle);
      assert.strictEqual(restore.engineAttempt, observed.attempt);
      assert.strictEqual(restore.role, observed.role);
      assert.equal(context.streamingEngineState().context.state, 'running');
      assert.notEqual(observed.role.firstFrameNotified, true);
      assert.equal(context.successfulPlaybackClaim(observed.handle), false);
      const lease = JSON.parse(context.getLocalStorageItem('albumhaven.playbackOwnership.v1'));
      assert.equal(lease.tab_id, observed.handle.tab_id);
      assert.equal(lease.claim_revision, observed.handle.claim_revision);
      assert.equal(lease.reason, 'restore_request');
      t.diagnostic(`active restore saved-state writes: ${JSON.stringify(observed.writes.map(value => JSON.parse(value)))}`);
      assert.ok(observed.writes.length > 0);
    }
    for (const value of observed.writes) {
      const persisted = JSON.parse(value);
      assert.equal(persisted.track.path, path);
      assert.equal(persisted.currentTime, offset);
      assert.equal(persisted.paused, paused);
    }
    assert.strictEqual(context.state.player, vm.runInContext('state.player', context));
  }
  return { context, observed, assertAdmission, ...fixturePlatforms.get(context) };
}

function loadPreissuedRestore(t, saved, { expectedAdmissionState = saved } = {}) {
  assert.equal(expectedAdmissionState.track.path, saved.track.path);
  assert.equal(expectedAdmissionState.track.src, saved.track.src);
  const f = loadRestoreAdmissionHelper(t, {
    state: { player: { current: null, playbackQueue: null, restoredFromStorage: false,
      lastKnownWasPlaying: false, lastPersistedSnapshot: '' } },
    getLocalStorageItem: () => JSON.stringify(saved),
    resolveAlbumForPlayerTrack: () => null,
  }, { paused: false });
  const { context } = f;
  const scope = context.capturePlaybackOwnershipScope();
  let restoreCurrent = null;
  const handle = context.canRestoreActivePlayback(saved, {
    isCurrent: () => context.isPlaybackOwnershipScopeCurrent(scope)
      && (restoreCurrent === null || restoreCurrent() === true),
  });
  assert.ok(handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.state.player.current, null);
  assert.equal(context.streamingEngineState().roles.current, null);
  const setupLease = context.getLocalStorageItem('albumhaven.playbackOwnership.v1');
  context.canRestoreActivePlayback = (parsed, options) => {
    if (!require('node:util').isDeepStrictEqual(JSON.parse(JSON.stringify(parsed)), expectedAdmissionState)
      || typeof options?.isCurrent !== 'function'
      || !context.isPlaybackOwnershipScopeCurrent(scope)
      || context.getActivePlaybackOwnershipHandle() !== handle
      || !context.isPlaybackOwnershipHandleCurrent(handle)) return false;
    restoreCurrent = options.isCurrent;
    if (restoreCurrent() !== true || !context.isPlaybackOwnershipScopeCurrent(scope)
      || context.getActivePlaybackOwnershipHandle() !== handle
      || !context.isPlaybackOwnershipHandleCurrent(handle)) return false;
    return handle;
  };
  return { ...f, handle, setupLease };
}

function loadHelper(overrides = {}) {
  const context = {
    PLAYER_STATE_STORAGE_KEY: 'albumhaven.playerState.v1',
    state: {
      player: {
        current: null,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
        restoredFromStorage: false,
        playbackQueue: ['queued'],
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      src: '',
      paused: true,
      ended: false,
      currentTime: 0,
      duration: 0,
    }),
    getLocalStorageItem: () => '',
    setLocalStorageItem: () => true,
    removeLocalStorageItem: () => true,
    setCurrentPlayerTrack: () => {},
    stopStreamingPlayback: () => Promise.resolve(),
    startStreamingTrack: () => Promise.resolve({ generation: 1, streamId: 1 }),
    canRestoreActivePlayback: () => true,
    getAlbumIdentity: (album) => String(album?.key || ''),
    resolveAlbumForPlayerTrack: () => null,
    setAlbumPlaybackQueue: () => {},
    updatePlayerUi: () => {},
    console,
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

{
  const context = loadHelper({
    state: {
      player: {
        current: {
          src: '/track?path=song.flac',
          path: 'C:/Music/song.flac',
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
          coverPath: 'C:/Music/cover.jpg',
        },
        lastKnownWasPlaying: true,
        lastPersistedSnapshot: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      src: '/track?path=song.flac',
      paused: false,
      ended: false,
      currentTime: 12.345,
      duration: 240.111,
    }),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.buildPersistedPlayerState())), {
    track: {
      src: '/track?path=song.flac',
      path: 'C:/Music/song.flac',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      coverPath: 'C:/Music/cover.jpg',
      durationSeconds: 240.111,
    },
    playbackQueue: null,
    currentTime: 12.35,
    paused: false,
    loop: { active: false, start: 0, end: 0 },
  });
}

{
  const currentTrack = {
    src: '/track?path=streamed.flac',
    path: 'C:/Music/streamed.flac',
    title: 'Streamed Song',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const context = loadHelper({
    state: {
      player: {
        current: currentTrack,
        playbackQueue: null,
        loopActive: true,
        loopStart: 4.25,
        loopEnd: 18.5,
        speed: 1.75,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      src: currentTrack.src,
      currentTime: 12.625,
      duration: 240,
      paused: false,
      ended: false,
      generation: 19,
      socket: { readyState: 1 },
      pcm: new Float32Array([0.25]),
      credits: { current: 48_000 },
    }),
  });

  const persisted = JSON.parse(JSON.stringify(context.buildPersistedPlayerState()));
  assert.deepEqual(Object.keys(persisted).sort(), [
    'currentTime',
    'loop',
    'paused',
    'playbackQueue',
    'track',
  ]);
  assert.equal(persisted.currentTime, 12.63, 'persistence uses the rendered streaming offset');
  assert.equal(persisted.paused, false, 'persistence keeps the streaming pause intent');
  assert.deepEqual(
    persisted.loop,
    { active: false, start: 4.25, end: 18.5 },
    'reload persistence keeps loop boundaries without preserving transient edit mode',
  );
  assert.equal('generation' in persisted, false);
  assert.equal('socket' in persisted, false);
  assert.equal('pcm' in persisted, false);
  assert.equal('credits' in persisted, false);
  assert.equal('speed' in persisted, false, 'the obsolete bottom-player speed is not serialized');
}

test('album artist and album snapshot survive streaming persistence and restore', async (t) => {
  const playingTrackPath = 'C:/Music/Various Artists/Featured Signal Collection/01 Signal.flac';
  const albumSnapshot = {
    key: 'featured-signal-collection',
    name: 'Featured Signal Collection',
    album_artist: 'Various Artists',
    tracks: [{
      path: playingTrackPath,
      title: 'Signal',
      artist: 'Solo Voice',
      album: 'Featured Signal Collection',
    }],
  };
  const persistedTrack = {
    src: '/track?path=signal.flac',
    path: playingTrackPath,
    title: 'Signal',
    artist: 'Solo Voice',
    albumArtist: 'Various Artists',
    album: 'Featured Signal Collection',
    coverPath: 'C:/Music/Various Artists/Featured Signal Collection/cover.jpg',
    durationSeconds: 30,
  };
  const buildContext = loadHelper({
    state: {
      player: {
        current: persistedTrack,
        playbackQueue: {
          tracks: [persistedTrack],
          currentIndex: 0,
          albumRef: albumSnapshot.key,
          albumSnapshot,
        },
        lastKnownWasPlaying: true,
        lastPersistedSnapshot: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      src: persistedTrack.src,
      paused: false,
      ended: false,
      currentTime: 7,
      duration: 30,
    }),
  });

  const persistedState = JSON.parse(JSON.stringify(buildContext.buildPersistedPlayerState()));
  assert.equal(persistedState.track.albumArtist, 'Various Artists');
  assert.equal(persistedState.track.durationSeconds, 30);
  assert.equal(persistedState.playbackQueue.tracks[0].albumArtist, 'Various Artists');
  assert.equal(persistedState.playbackQueue.tracks[0].durationSeconds, 30);
  assert.equal(persistedState.playbackQueue.albumRef, albumSnapshot.key);
  assert.deepEqual(persistedState.playbackQueue.albumSnapshot, albumSnapshot);

  const restoredTracks = [];
  const { context: restoreContext, assertAdmission } = loadRestoreAdmissionHelper(t, {
    state: {
      player: {
        current: null,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
        restoredFromStorage: false,
        playbackQueue: null,
      },
    },
    getLocalStorageItem: () => JSON.stringify(persistedState),
  }, { paused: false });
  restoreContext.getAlbumIdentity = (album) => String(album?.key || '');
  const setCurrent = restoreContext.setCurrentPlayerTrack;
  restoreContext.setCurrentPlayerTrack = (track, ...args) => {
    restoredTracks.push(track);
    return setCurrent(track, ...args);
  };
  let initialPageshow = null;
  const addEventListener = restoreContext.addEventListener;
  restoreContext.addEventListener = (name, callback, ...args) => {
    if (name === 'pageshow') initialPageshow = callback;
    return addEventListener(name, callback, ...args);
  };

  restoreContext.restorePlayerState();
  assert.equal(typeof initialPageshow, 'function');
  initialPageshow();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(restoredTracks[0].albumArtist, 'Various Artists');
  assert.equal(restoredTracks[0].durationSeconds, 30);
  assert.equal(restoreContext.state.player.playbackQueue.albumRef, albumSnapshot.key);
  assert.deepEqual(
    JSON.parse(JSON.stringify(restoreContext.state.player.playbackQueue.albumSnapshot)),
    albumSnapshot,
  );
  assertAdmission(playingTrackPath, 7);
});

{
  const calls = [];
  const context = loadHelper({
    state: {
      player: {
        current: {
          src: '/track?path=song.flac',
          path: 'C:/Music/song.flac',
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
          coverPath: '',
        },
        lastKnownWasPlaying: true,
        lastPersistedSnapshot: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      src: '/track?path=song.flac',
      paused: true,
      ended: false,
      currentTime: 3.219,
      duration: 10,
    }),
    setLocalStorageItem: (key, value) => {
      calls.push([key, value]);
      return true;
    },
  });

  context.persistPlayerState(true, { preservePlayingState: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'albumhaven.playerState.v1');
  assert.deepEqual(JSON.parse(calls[0][1]), {
    track: {
      src: '/track?path=song.flac',
      path: 'C:/Music/song.flac',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      coverPath: '',
      durationSeconds: 10,
    },
    playbackQueue: null,
    currentTime: 3.22,
    paused: false,
    loop: { active: false, start: 0, end: 0 },
  });
}

test('paired unload events preserve the first rendered snapshot exactly once', (t) => {
  const storedSnapshots = [];
  const flushedReasons = [];
  let releaseCalls = 0;
  let renderedCurrentTime = 3.219;
  const currentTrack = {
    src: '/track?path=song.flac',
    path: 'C:/Music/song.flac',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const context = loadUnloadHelper(t, {
    state: {
      player: {
        current: currentTrack,
        lastKnownWasPlaying: true,
        lastPersistedSnapshot: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      src: currentTrack.src,
      paused: true,
      ended: false,
      currentTime: renderedCurrentTime,
      duration: 10,
    }),
    setLocalStorageItem: (_key, value) => {
      storedSnapshots.push(JSON.parse(value));
      return true;
    },
    flushListenSessionOnUnload: (reason) => {
      flushedReasons.push(reason);
    },
  });
  const releasePlaybackOwnership = context.releasePlaybackOwnership;
  context.releasePlaybackOwnership = (...args) => {
    const result = releasePlaybackOwnership(...args);
    releaseCalls += 1;
    context.state.player.lastKnownWasPlaying = false;
    context.persistPlayerState();
    return result;
  };

  context.persistPlayerStateForUnload('pagehide');
  renderedCurrentTime = 0;
  context.persistPlayerStateForUnload('beforeunload');

  assert.equal(releaseCalls, 1);
  assert.deepEqual(flushedReasons, ['pagehide']);
  assert.deepEqual(storedSnapshots.map((snapshot) => snapshot.paused), [false]);
  assert.equal(storedSnapshots.at(-1).currentTime, 3.22);
  assert.equal(storedSnapshots.at(-1).paused, false);
});

test('unload preserves the rendered playhead before playback ownership teardown', (t) => {
  const storedSnapshots = [];
  const playback = {
    src: '/track?path=song.flac',
    paused: false,
    ended: false,
    currentTime: 37.25,
    duration: 120,
  };
  const currentTrack = {
    src: playback.src,
    path: 'C:/Music/song.flac',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const context = loadUnloadHelper(t, {
    state: {
      player: {
        current: currentTrack,
        lastKnownWasPlaying: true,
        lastPersistedSnapshot: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({ ...playback }),
    setLocalStorageItem: (_key, value) => {
      storedSnapshots.push(JSON.parse(value));
      return true;
    },
    flushListenSessionOnUnload: () => {},
  });
  const releasePlaybackOwnership = context.releasePlaybackOwnership;
  context.releasePlaybackOwnership = (...args) => {
    const result = releasePlaybackOwnership(...args);
    playback.paused = true;
    playback.currentTime = 0;
    return result;
  };

  context.persistPlayerStateForUnload('pagehide');
  context.persistPlayerState(true, { preservePlayingState: true });

  assert.equal(storedSnapshots.length, 1);
  assert.equal(storedSnapshots[0].currentTime, 37.25);
  assert.equal(storedSnapshots[0].paused, false);
});

test('BFCache restoration re-enables normal player-state persistence after pagehide', (t) => {
  const storedSnapshots = [];
  const playback = {
    src: '/track?path=song.flac',
    paused: false,
    ended: false,
    currentTime: 12,
    duration: 120,
  };
  const currentTrack = {
    src: playback.src,
    path: 'C:/Music/song.flac',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const context = loadUnloadHelper(t, {
    state: {
      player: {
        current: currentTrack,
        lastKnownWasPlaying: true,
        lastPersistedSnapshot: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({ ...playback }),
    setLocalStorageItem: (_key, value) => {
      storedSnapshots.push(JSON.parse(value));
      return true;
    },
    flushListenSessionOnUnload: () => {},
  });

  context.persistPlayerStateForUnload('pagehide');
  playback.currentTime = 48;
  context.persistPlayerState();
  assert.equal(storedSnapshots.length, 1, 'ordinary persistence stays blocked during teardown');

  context.resetPlayerUnloadPersistence();
  context.persistPlayerState();

  assert.equal(storedSnapshots.length, 2);
  assert.equal(storedSnapshots.at(-1).currentTime, 48);
});

{
  const context = loadHelper({
    state: {
      player: {
        current: {
          src: '/track?path=song2.flac',
          path: 'C:/Music/song2.flac',
          title: 'Song 2',
          artist: 'Artist',
          album: 'Album',
          coverPath: '',
        },
        playbackQueue: {
          tracks: [
            {
              src: '/track?path=song1.flac',
              path: 'C:/Music/song1.flac',
              title: 'Song 1',
              artist: 'Artist',
              album: 'Album',
              coverPath: '',
            },
            {
              src: '/track?path=song2.flac',
              path: 'C:/Music/song2.flac',
              title: 'Song 2',
              artist: 'Artist',
              album: 'Album',
              coverPath: '',
            },
            {
              src: '/track?path=song3.flac',
              path: 'C:/Music/song3.flac',
              title: 'Song 3',
              artist: 'Artist',
              album: 'Album',
              coverPath: '',
            },
          ],
          currentIndex: 1,
        },
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
      },
    },
    getPlayerPlaybackSnapshot: () => ({
      src: '/track?path=song2.flac',
      paused: true,
      ended: false,
      currentTime: 3,
      duration: 10,
    }),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.buildPersistedPlayerState())), {
    track: {
      src: '/track?path=song2.flac',
      path: 'C:/Music/song2.flac',
      title: 'Song 2',
      artist: 'Artist',
      album: 'Album',
      coverPath: '',
      durationSeconds: 10,
    },
    playbackQueue: {
      tracks: [
        {
          src: '/track?path=song1.flac',
          path: 'C:/Music/song1.flac',
          title: 'Song 1',
          artist: 'Artist',
          album: 'Album',
          coverPath: '',
        },
        {
          src: '/track?path=song2.flac',
          path: 'C:/Music/song2.flac',
          title: 'Song 2',
          artist: 'Artist',
          album: 'Album',
          coverPath: '',
        },
        {
          src: '/track?path=song3.flac',
          path: 'C:/Music/song3.flac',
          title: 'Song 3',
          artist: 'Artist',
          album: 'Album',
          coverPath: '',
        },
      ],
      currentIndex: 1,
    },
    currentTime: 3,
    paused: true,
    loop: { active: false, start: 0, end: 0 },
  });
}

test('restore normalizes a persisted queue before opening the fresh streaming role', async (t) => {
  const calls = {
    setCurrentPlayerTrack: [],
    resolveAlbumForPlayerTrack: [],
    setAlbumPlaybackQueue: [],
    stopStreamingPlayback: [],
    startStreamingTrack: [],
    updatePlayerUi: 0,
  };
  const restoredAlbum = {
    key: 'album',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: 'C:/Music/song.flac' }, { path: 'C:/Music/next.flac' }],
  };
  const overrides = {
    state: {
      player: {
        current: null,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
        restoredFromStorage: false,
        playbackQueue: ['queued'],
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: {
        src: '/track?path=song.flac',
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
      },
      playbackQueue: {
        tracks: [
          {
            src: '/track?path=song.flac',
            path: 'C:/Music/song.flac',
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            coverPath: '',
          },
          {
            src: '/track?path=next.flac',
            path: 'C:/Music/next.flac',
            title: 'Next Song',
            artist: 'Artist',
            album: 'Album',
            coverPath: '',
          },
          {
            src: '/track?path=other.flac',
            path: 'C:/Music/Other Artist/Other Album/01 Other.flac',
            title: 'Other Song',
            artist: 'Other Artist',
            album: 'Other Album',
            coverPath: '',
          },
        ],
        currentIndex: 0,
      },
      currentTime: 45,
      paused: false,
      loop: { active: false, start: 0, end: 0 },
    }),
    setCurrentPlayerTrack: (track) => { calls.setCurrentPlayerTrack.push(track); },
    stopStreamingPlayback: (reason) => {
      calls.stopStreamingPlayback.push(reason);
      return Promise.resolve();
    },
    startStreamingTrack: (track, options) => {
      calls.startStreamingTrack.push([track, options]);
      return Promise.resolve({ generation: 2, streamId: 21 });
    },
    resolveAlbumForPlayerTrack: (track) => {
      calls.resolveAlbumForPlayerTrack.push(track);
      return restoredAlbum;
    },
    setAlbumPlaybackQueue: (album, trackPath) => {
      calls.setAlbumPlaybackQueue.push([album, trackPath]);
    },
    getAlbumIdentity: (album) => String(album?.key || ''),
    updatePlayerUi: () => { calls.updatePlayerUi += 1; },
    setLocalStorageItem: () => true,
  };
  const saved = JSON.parse(overrides.getLocalStorageItem());
  assert.equal(Object.hasOwn(saved.track, 'albumArtist'), false);
  const expectedAdmissionState = { ...saved, track: { ...saved.track, albumArtist: restoredAlbum.album_artist } };
  const f = loadPreissuedRestore(t, saved, { expectedAdmissionState });
  const { context, platform, observed, handle } = f;
  Object.assign(context.state.player, overrides.state.player);
  assert.strictEqual(context.state.player, vm.runInContext('state.player', context));
  assert.equal(context.state.player.current, null);
  assert.equal(context.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.isPlaybackOwnershipScopeCurrent(context.capturePlaybackOwnershipScope()), true);
  let nativeResumeCalls = 0;
  platform.onContextCreate = audioContext => {
    assert.equal(audioContext.state, 'suspended');
    // Finite adapter state/race input, not a claim about ordinary browser policy.
    // Only the native resume result is controlled; engine state/authority stay real.
    audioContext.resume = () => { nativeResumeCalls += 1; return Promise.resolve(); };
  };
  // Install the original unit observers only after the exact-track grant setup.
  // Do not expand the isolated setter into cover resolution or an extra UI paint.
  context.setCurrentPlayerTrack = (track, options) => {
    assert.equal(options.isCurrent(), true);
    overrides.setCurrentPlayerTrack(track, options);
    context.state.player.current = track;
  };
  context.resolveAlbumForPlayerTrack = overrides.resolveAlbumForPlayerTrack;
  context.setAlbumPlaybackQueue = overrides.setAlbumPlaybackQueue;
  context.getAlbumIdentity = overrides.getAlbumIdentity;
  context.updatePlayerUi = overrides.updatePlayerUi;
  const start = context.startStreamingTrack, stop = context.stopStreamingPlayback;
  const queuesAtStart = [];
  context.startStreamingTrack = (track, options) => {
    calls.startStreamingTrack.push([track, options]);
    queuesAtStart.push(JSON.parse(JSON.stringify(context.state.player.playbackQueue)));
    return start(track, options); // Forward actual callbacks unchanged at this seam.
  };
  context.stopStreamingPlayback = (...args) => {
    calls.stopStreamingPlayback.push(...args);
    return stop(...args);
  };

  context.restorePlayerState();
  context.window.dispatchEvent(new context.Event('pageshow'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.setCurrentPlayerTrack.length, 1);
  assert.equal(calls.resolveAlbumForPlayerTrack.length, 1);
  assert.equal(calls.setAlbumPlaybackQueue.length, 0);
  assert.equal(calls.setCurrentPlayerTrack[0].albumArtist, 'Artist');
  assert.deepEqual(calls.stopStreamingPlayback, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.startStreamingTrack[0])),
    [
      JSON.parse(JSON.stringify(calls.setCurrentPlayerTrack[0])),
      {
        startSeconds: 45,
        autoplay: true,
        allowSuspendedAutoplayFallback: true,
      },
    ],
  );
  assert.equal(calls.updatePlayerUi, 1);
  assert.equal(context.state.player.restoredFromStorage, true);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.player.playbackQueue)), {
    tracks: [
      {
        src: '/track?path=song.flac',
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        albumArtist: 'Artist',
        album: 'Album',
        coverPath: '',
      },
      {
        src: '/track?path=next.flac',
        path: 'C:/Music/next.flac',
        title: 'Next Song',
        artist: 'Artist',
        albumArtist: 'Artist',
        album: 'Album',
        coverPath: '',
      },
      {
        src: '/track?path=other.flac',
        path: 'C:/Music/Other Artist/Other Album/01 Other.flac',
        title: 'Other Song',
        artist: 'Other Artist',
        album: 'Other Album',
        coverPath: '',
      },
    ],
    currentIndex: 0,
    albumRef: 'album',
    albumSnapshot: restoredAlbum,
  });
  assert.equal(context.state.player.playbackQueue.tracks[2].albumArtist, undefined);
  assert.equal(nativeResumeCalls, 1);
  assert.equal(observed.error, null);
  assert.equal(observed.settled, true);
  assert.ok(observed.role);
  assert.ok(observed.attempt);
  assert.strictEqual(context.streamingEngineState().roles.current, observed.role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(observed.attempt), true);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.getPlayerPlaybackSnapshot().currentTime, 45);
  assert.equal(context.getPlayerPlaybackSnapshot().paused, true);
  assert.equal(context.streamingEngineState().context.state, 'suspended');
  assert.notEqual(observed.role.firstFrameNotified, true);
  assert.equal(context.successfulPlaybackClaim(handle), false);
  const restore = vm.runInContext('playerRestoreAttempt', context);
  assert.strictEqual(restore.role, observed.role);
  assert.strictEqual(restore.engineAttempt, observed.attempt);
  assert.equal(restore.autoplayHandled, false);
  assert.equal(queuesAtStart.length, 1);
  assert.deepEqual(queuesAtStart[0].tracks.map(track => track.path),
    JSON.parse(JSON.stringify(context.state.player.playbackQueue.tracks.map(track => track.path))));
  assert.equal(queuesAtStart[0].currentIndex, context.state.player.playbackQueue.currentIndex);
});

test('running autoplay restore preserves the same normalized queue before opening its real role', async (t) => {
  const calls = {
    setCurrentPlayerTrack: [],
    resolveAlbumForPlayerTrack: [],
    setAlbumPlaybackQueue: [],
    stopStreamingPlayback: [],
    startStreamingTrack: [],
    updatePlayerUi: 0,
  };
  const restoredAlbum = {
    key: 'album',
    name: 'Album',
    album_artist: 'Artist',
    tracks: [{ path: 'C:/Music/song.flac' }, { path: 'C:/Music/next.flac' }],
  };
  const overrides = {
    state: {
      player: {
        current: null,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
        restoredFromStorage: false,
        playbackQueue: ['queued'],
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: {
        src: '/track?path=song.flac',
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
      },
      playbackQueue: {
        tracks: [
          {
            src: '/track?path=song.flac',
            path: 'C:/Music/song.flac',
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            coverPath: '',
          },
          {
            src: '/track?path=next.flac',
            path: 'C:/Music/next.flac',
            title: 'Next Song',
            artist: 'Artist',
            album: 'Album',
            coverPath: '',
          },
          {
            src: '/track?path=other.flac',
            path: 'C:/Music/Other Artist/Other Album/01 Other.flac',
            title: 'Other Song',
            artist: 'Other Artist',
            album: 'Other Album',
            coverPath: '',
          },
        ],
        currentIndex: 0,
      },
      currentTime: 45,
      paused: false,
      loop: { active: false, start: 0, end: 0 },
    }),
    setCurrentPlayerTrack: (track) => { calls.setCurrentPlayerTrack.push(track); },
    resolveAlbumForPlayerTrack: (track) => {
      calls.resolveAlbumForPlayerTrack.push(track);
      return restoredAlbum;
    },
    setAlbumPlaybackQueue: (album, trackPath) => {
      calls.setAlbumPlaybackQueue.push([album, trackPath]);
    },
    getAlbumIdentity: (album) => String(album?.key || ''),
    updatePlayerUi: () => { calls.updatePlayerUi += 1; },
  };
  const saved = JSON.parse(overrides.getLocalStorageItem());
  assert.equal(Object.hasOwn(saved.track, 'albumArtist'), false);
  const expectedAdmissionState = { ...saved, track: { ...saved.track, albumArtist: restoredAlbum.album_artist } };
  const f = loadPreissuedRestore(t, saved, { expectedAdmissionState });
  const { context, platform, observed, handle } = f;
  Object.assign(context.state.player, overrides.state.player);
  assert.strictEqual(context.state.player, vm.runInContext('state.player', context));
  assert.equal(context.state.player.current, null);
  assert.equal(context.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.isPlaybackOwnershipScopeCurrent(context.capturePlaybackOwnershipScope()), true);
  let nativeResumeCalls = 0;
  platform.onContextCreate = audioContext => {
    const resume = audioContext.resume.bind(audioContext);
    audioContext.resume = (...args) => { nativeResumeCalls += 1; return resume(...args); };
  };
  // Install the original unit observers only after the exact-track grant setup.
  // Do not expand the isolated setter into cover resolution or an extra UI paint.
  context.setCurrentPlayerTrack = (track, options) => {
    assert.equal(options.isCurrent(), true);
    overrides.setCurrentPlayerTrack(track, options);
    context.state.player.current = track;
  };
  context.resolveAlbumForPlayerTrack = overrides.resolveAlbumForPlayerTrack;
  context.setAlbumPlaybackQueue = overrides.setAlbumPlaybackQueue;
  context.getAlbumIdentity = overrides.getAlbumIdentity;
  context.updatePlayerUi = overrides.updatePlayerUi;
  const start = context.startStreamingTrack, stop = context.stopStreamingPlayback;
  const queuesAtStart = [];
  context.startStreamingTrack = (track, options) => {
    calls.startStreamingTrack.push([track, options]);
    queuesAtStart.push(JSON.parse(JSON.stringify(context.state.player.playbackQueue)));
    return start(track, options); // Forward actual callbacks unchanged at this seam.
  };
  context.stopStreamingPlayback = (...args) => {
    calls.stopStreamingPlayback.push(...args);
    return stop(...args);
  };

  context.restorePlayerState();
  context.window.dispatchEvent(new context.Event('pageshow'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.setCurrentPlayerTrack.length, 1);
  assert.equal(calls.resolveAlbumForPlayerTrack.length, 1);
  assert.equal(calls.setAlbumPlaybackQueue.length, 0);
  assert.equal(calls.setCurrentPlayerTrack[0].albumArtist, 'Artist');
  assert.deepEqual(calls.stopStreamingPlayback, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.startStreamingTrack[0])),
    [
      JSON.parse(JSON.stringify(calls.setCurrentPlayerTrack[0])),
      {
        startSeconds: 45,
        autoplay: true,
        allowSuspendedAutoplayFallback: true,
      },
    ],
  );
  assert.equal(calls.updatePlayerUi, 2, 'active completion and restore tail remain observable');
  assert.equal(context.state.player.restoredFromStorage, true);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.player.playbackQueue)), {
    tracks: [
      {
        src: '/track?path=song.flac',
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        albumArtist: 'Artist',
        album: 'Album',
        coverPath: '',
      },
      {
        src: '/track?path=next.flac',
        path: 'C:/Music/next.flac',
        title: 'Next Song',
        artist: 'Artist',
        albumArtist: 'Artist',
        album: 'Album',
        coverPath: '',
      },
      {
        src: '/track?path=other.flac',
        path: 'C:/Music/Other Artist/Other Album/01 Other.flac',
        title: 'Other Song',
        artist: 'Other Artist',
        album: 'Other Album',
        coverPath: '',
      },
    ],
    currentIndex: 0,
    albumRef: 'album',
    albumSnapshot: restoredAlbum,
  });
  assert.equal(context.state.player.playbackQueue.tracks[2].albumArtist, undefined);
  assert.equal(nativeResumeCalls, 1);
  assert.equal(observed.error, null);
  assert.equal(observed.settled, true);
  assert.ok(observed.role);
  assert.ok(observed.attempt);
  assert.strictEqual(context.streamingEngineState().roles.current, observed.role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(observed.attempt), true);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(handle), true);
  assert.equal(context.getPlayerPlaybackSnapshot().currentTime, 45);
  assert.equal(context.getPlayerPlaybackSnapshot().paused, false);
  assert.equal(context.streamingEngineState().context.state, 'running');
  assert.notEqual(observed.role.firstFrameNotified, true);
  assert.equal(context.successfulPlaybackClaim(handle), false);
  const restore = vm.runInContext('playerRestoreAttempt', context);
  assert.strictEqual(restore.role, observed.role);
  assert.strictEqual(restore.engineAttempt, observed.attempt);
  assert.equal(restore.autoplayHandled, true);
  assert.equal(queuesAtStart.length, 1);
  assert.deepEqual(queuesAtStart[0].tracks.map(track => track.path),
    JSON.parse(JSON.stringify(context.state.player.playbackQueue.tracks.map(track => track.path))));
  assert.equal(queuesAtStart[0].currentIndex, context.state.player.playbackQueue.currentIndex);
});

test('restore refreshes a stale album snapshot while preserving queue order', async (t) => {
  const currentTrackPath = 'C:/Music/Various Artists/Featured Signal Collection/02 Current.flac';
  const firstTrackPath = 'C:/Music/Various Artists/Featured Signal Collection/01 First.flac';
  const freshAlbum = {
    key: 'featured-signal-collection',
    name: 'Featured Signal Collection',
    album_artist: 'Various Artists',
    tracks: [{ path: firstTrackPath }, { path: currentTrackPath }],
  };
  const staleAlbum = {
    key: 'stale-album',
    name: 'Stale Album',
    album_artist: 'Wrong Artist',
    tracks: [{ path: 'C:/Music/Wrong Artist/Stale Album/01 Stale.flac' }],
  };
  const calls = {
    resolveAlbumForPlayerTrack: [],
    setAlbumPlaybackQueue: [],
    setCurrentPlayerTrack: [],
  };
  const overrides = {
    state: {
      player: {
        current: null,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
        restoredFromStorage: false,
        playbackQueue: null,
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: {
        src: '/track?path=current.flac',
        path: currentTrackPath,
        title: 'Current',
        artist: 'Solo Voice',
        album: 'Featured Signal Collection',
        coverPath: '',
      },
      playbackQueue: {
        tracks: [
          {
            src: '/track?path=first.flac',
            path: firstTrackPath,
            title: 'First',
            artist: 'Lead Voice',
            album: 'Featured Signal Collection',
            coverPath: '',
          },
          {
            src: '/track?path=current.flac',
            path: currentTrackPath,
            title: 'Current',
            artist: 'Solo Voice',
            album: 'Featured Signal Collection',
            coverPath: '',
          },
        ],
        currentIndex: 1,
        albumRef: freshAlbum.key,
        albumSnapshot: staleAlbum,
      },
      currentTime: 5,
      paused: true,
      loop: { active: false, start: 0, end: 0 },
    }),
    getAlbumIdentity: (album) => String(album?.key || ''),
    resolveAlbumForPlayerTrack: (track) => {
      calls.resolveAlbumForPlayerTrack.push(track);
      return freshAlbum;
    },
    setAlbumPlaybackQueue: (album, trackPath) => {
      calls.setAlbumPlaybackQueue.push([album, trackPath]);
    },
    setCurrentPlayerTrack: (track, options) => {
      assert.equal(options.isCurrent(), true);
      calls.setCurrentPlayerTrack.push(track);
      context.state.player.current = track;
    },
    setLocalStorageItem: () => true,
  };
  const { context, assertAdmission } = loadRestoreAdmissionHelper(t, overrides);
  // Keep the original isolated current-track dependency: cover lookup and UI
  // painting belong to the full setter, not this queue-normalization subject.
  context.setCurrentPlayerTrack = overrides.setCurrentPlayerTrack;
  context.setAlbumPlaybackQueue = overrides.setAlbumPlaybackQueue;
  context.getAlbumIdentity = overrides.getAlbumIdentity;

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.resolveAlbumForPlayerTrack.length, 1);
  assert.equal(calls.setAlbumPlaybackQueue.length, 0);
  assert.equal(calls.setCurrentPlayerTrack[0].albumArtist, 'Various Artists');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.player.playbackQueue.tracks.map((track) => track.path))),
    [firstTrackPath, currentTrackPath],
  );
  assert.equal(context.state.player.playbackQueue.currentIndex, 1);
  assert.equal(context.state.player.playbackQueue.albumRef, freshAlbum.key);
  assert.strictEqual(context.state.player.playbackQueue.albumSnapshot, freshAlbum);
  assert.equal(
    context.state.player.playbackQueue.tracks[1].albumArtist,
    'Various Artists',
  );
  assertAdmission(currentTrackPath, 5);
});

test('restore clears a missing persisted queue', async (t) => {
  const { context, assertAdmission } = loadRestoreAdmissionHelper(t, {
    state: {
      player: {
        current: null,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
        restoredFromStorage: false,
        playbackQueue: ['queued'],
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: {
        src: '/track?path=song.flac',
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
      },
      playbackQueue: null,
      currentTime: 5,
      paused: true,
      loop: { active: false, start: 0, end: 0 },
    }),
    resolveAlbumForPlayerTrack: () => null,
  });

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(context.state.player.playbackQueue, null);
  assertAdmission('C:/Music/song.flac', 5);
});
test('restore honors ownership denial by keeping a saved playing track suspended', async (t) => {
  const calls = {
    startStreamingTrack: [],
    setCurrentPlayerTrack: [],
    updatePlayerUi: 0,
  };
  const overrides = {
    state: {
      player: {
        current: null,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
        restoredFromStorage: false,
        playbackQueue: ['queued'],
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: {
        src: '/track?path=song.flac',
        path: 'C:/Music/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        coverPath: '',
      },
      playbackQueue: null,
      currentTime: 12,
      paused: false,
      loop: { active: false, start: 0, end: 0 },
    }),
    canRestoreActivePlayback: () => false,
    startStreamingTrack: (track, options) => {
      calls.startStreamingTrack.push([track, options]);
      return Promise.resolve({ generation: 2, streamId: 22 });
    },
    setCurrentPlayerTrack: (track) => { calls.setCurrentPlayerTrack.push(track); },
    updatePlayerUi: () => { calls.updatePlayerUi += 1; },
    setLocalStorageItem: () => true,
  };
  const { context, observed } = loadRestoreAdmissionHelper(t, overrides, { paused: true });
  context.document.readyState = 'loading';
  assert.equal(context.document.getElementById('capability-bootstrap'), null);
  const policy = context.document.createElement('script');
  policy.id = 'capability-bootstrap';
  policy.textContent = JSON.stringify({ allowed_actions: { 'library.media.read': true } });
  context.document.body.append(policy);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/capability-ui.js'), 'utf8'), context);
  assert.equal(context.AlbumHavenCapabilities.allows('library.media.read'), true);
  const scope = context.capturePlaybackOwnershipScope();
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  assert.equal(context.streamingEngineState().roles.current, null);
  assert.strictEqual(context.state.player, vm.runInContext('state.player', context));
  context.updatePlayerUi = overrides.updatePlayerUi;
  let denials = 0;
  context.canRestoreActivePlayback = (...args) => {
    denials += 1;
    assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
    assert.equal(context.getActivePlaybackOwnershipHandle(), null);
    const result = overrides.canRestoreActivePlayback(...args);
    observed.handle = result; // Record the actual false denial, never a grant.
    return result;
  };
  const actualStart = context.startStreamingTrack;
  context.startStreamingTrack = (track, options) => {
    calls.startStreamingTrack.push([track, options]);
    return actualStart(track, options);
  };
  // Preserve the original isolated metadata setter boundary; use the exact
  // player record read by restore, without adding full-setter UI effects.
  context.setCurrentPlayerTrack = (track, options) => {
    if (options?.isCurrent) assert.equal(options.isCurrent(), true);
    overrides.setCurrentPlayerTrack(track, options);
    context.state.player.current = track;
  };

  context.restorePlayerState();
  context.window.dispatchEvent(new context.Event('pageshow'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(denials, 1, 'the original exact-false seam was reached');
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  assert.equal(calls.startStreamingTrack.length, 1, 'denied active restore still requests the preserved paused start');

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.startStreamingTrack[0])),
    [
      JSON.parse(JSON.stringify(calls.setCurrentPlayerTrack[0])),
      { startSeconds: 12, autoplay: false },
    ],
  );
  assert.equal(calls.updatePlayerUi, 1);
});

test('restore exposes the full persisted track before browser audio startup can resume', (t) => {
  const restoredTrack = {
    src: '/track?path=restored.flac',
    path: 'C:/Music/restored.flac',
    title: 'Restored Song',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 181,
  };
  const calls = {
    setCurrentPlayerTrack: [],
    updatePlayerUi: 0,
  };
  const overrides = {
    state: {
      player: {
        current: null,
        playbackQueue: null,
        restoredFromStorage: false,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: restoredTrack,
      playbackQueue: null,
      currentTime: 33,
      paused: false,
      loop: { active: true, start: 0, end: 30 },
    }),
    startStreamingTrack: () => new Promise(() => {}),
    setCurrentPlayerTrack: (track, options) => {
      calls.setCurrentPlayerTrack.push([track, options]);
      context.state.player.current = track;
    },
    updatePlayerUi: () => { calls.updatePlayerUi += 1; },
  };
  const { context } = loadRestoreAdmissionHelper(t, overrides, { paused: true });
  context.document.readyState = 'loading';
  assert.equal(context.document.getElementById('capability-bootstrap'), null);
  const policy = context.document.createElement('script');
  policy.id = 'capability-bootstrap';
  policy.textContent = JSON.stringify({ allowed_actions: { 'library.media.read': true } });
  context.document.body.append(policy);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/capability-ui.js'), 'utf8'), context);
  assert.equal(context.AlbumHavenCapabilities.allows('library.media.read'), true);
  const scope = context.capturePlaybackOwnershipScope();
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  assert.equal(context.streamingEngineState().roles.current, null);
  assert.strictEqual(context.state.player, vm.runInContext('state.player', context));
  context.updatePlayerUi = overrides.updatePlayerUi;
  context.startStreamingTrack = overrides.startStreamingTrack;
  context.setCurrentPlayerTrack = overrides.setCurrentPlayerTrack;
  // No pageshow or await before the original synchronous metadata assertions.

  context.restorePlayerState();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.setCurrentPlayerTrack)),
    [[restoredTrack, { persist: false }]],
  );
  assert.equal(context.state.player.current.durationSeconds, 181);
  assert.equal(context.state.player.loopActive, false);
  assert.equal(context.state.player.loopStart, 0);
  assert.equal(context.state.player.loopEnd, 30);
  assert.equal(calls.updatePlayerUi, 1);
});

test('paused restore requests waveform peaks after the restored streaming role is current', async (t) => {
  const waveformCalls = [];
  const restoredTrack = {
    src: '/track?path=restored.flac',
    path: 'C:/Music/restored.flac',
    title: 'Restored Song',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 181,
  };
  const { context, assertAdmission } = loadRestoreAdmissionHelper(t, {
    state: {
      player: {
        current: null,
        playbackQueue: null,
        restoredFromStorage: false,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: restoredTrack,
      playbackQueue: null,
      currentTime: 33,
      paused: true,
      loop: { active: false, start: 0, end: 181 },
    }),
    resolveAlbumForPlayerTrack: () => null,
  });

  const scope = context.capturePlaybackOwnershipScope();
  let previousAttempt = null;
  let transport = null;
  assert.equal(context.streamingEngineState().generation, 0);
  for (let generation = 1; generation <= 7; generation += 1) {
    let attempt = null;
    const role = await context.startStreamingTrack(restoredTrack, {
      startSeconds: 0,
      autoplay: false,
      onStartAttempt(value) { attempt = value; },
    });
    const engine = context.streamingEngineState();
    assert.ok(attempt);
    assert.ok(role);
    assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
    assert.strictEqual(engine.roles.current, role);
    assert.equal(role.generation, generation);
    assert.equal(engine.generation, generation);
    assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
    assert.equal(context.getActivePlaybackOwnershipHandle(), null);
    assert.equal(context.state.player.current, null);
    assert.equal(engine.snapshot.paused, true);
    assert.equal(engine.context.state, 'suspended');
    assert.equal(engine.socket.readyState, context.WebSocket.CONNECTING);
    if (previousAttempt) assert.equal(context.isStreamingPlaybackAttemptCurrent(previousAttempt), false);
    if (transport) {
      assert.strictEqual(engine.context, transport.context);
      assert.strictEqual(engine.node, transport.node);
      assert.strictEqual(engine.socket, transport.socket);
    } else {
      transport = { context: engine.context, node: engine.node, socket: engine.socket };
    }
    previousAttempt = attempt;
  }
  context.handleStreamingPlaybackWaveformReady = (event) => {
    waveformCalls.push(event);
    return Promise.resolve();
  };

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(waveformCalls)), [{
    generation: 8,
    currentPath: restoredTrack.path,
    continuityPath: '',
  }]);
  assertAdmission(restoredTrack.path, 33);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(previousAttempt), false);
});

test('blocked active restore reconciles waveform and persists the retained paused role', async (t) => {
  const waveformCalls = [];
  const persistedStates = [];
  let initialPageshow = null;
  const restoredTrack = {
    src: '/track?path=blocked-restore.flac',
    path: 'C:/Music/blocked-restore.flac',
    title: 'Blocked Restore',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 181,
  };
  const f = loadPreissuedRestore(t, {
    track: restoredTrack,
    playbackQueue: null,
    currentTime: 33,
    paused: false,
    loop: { active: false, start: 0, end: 181 },
  });
  const { context } = f;
  const scope = context.capturePlaybackOwnershipScope();
  let previousAttempt = null;
  let transport = null;
  assert.equal(context.streamingEngineState().generation, 0);
  for (let generation = 1; generation <= 3; generation += 1) {
    let attempt = null;
    const role = await context.startStreamingTrack(restoredTrack, {
      startSeconds: 0, autoplay: false,
      onStartAttempt(value) { attempt = value; },
    });
    const engine = context.streamingEngineState();
    assert.ok(attempt);
    assert.ok(role);
    assert.equal(context.isStreamingPlaybackAttemptCurrent(attempt), true);
    assert.strictEqual(engine.roles.current, role);
    assert.equal(engine.generation, generation);
    assert.equal(role.generation, generation);
    assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
    assert.strictEqual(context.getActivePlaybackOwnershipHandle(), f.handle);
    assert.equal(context.state.player.current, null);
    assert.equal(engine.snapshot.paused, true);
    assert.equal(engine.context.state, 'suspended');
    assert.equal(engine.socket.readyState, context.WebSocket.CONNECTING);
    if (previousAttempt) assert.equal(context.isStreamingPlaybackAttemptCurrent(previousAttempt), false);
    if (transport) {
      assert.strictEqual(engine.context, transport.context);
      assert.strictEqual(engine.node, transport.node);
      assert.strictEqual(engine.socket, transport.socket);
    } else {
      transport = { context: engine.context, node: engine.node, socket: engine.socket };
    }
    previousAttempt = attempt;
  }
  f.platform.holds.resume = true;
  let signalResumeEntered;
  const resumeEntered = new Promise(resolve => { signalResumeEntered = resolve; });
  const audio = transport.context;
  const resume = audio.resume;
  audio.resume = function (...args) {
    const work = resume.apply(this, args);
    signalResumeEntered();
    return work;
  };
  context.setCurrentPlayerTrack = (track) => { context.state.player.current = track; };
  context.handleStreamingPlaybackWaveformReady = (event) => {
    waveformCalls.push(event);
    return Promise.resolve();
  };
  const write = context.setLocalStorageItem;
  context.setLocalStorageItem = (key, value) => {
    persistedStates.push([key, JSON.parse(value)]);
    return write(key, value);
  };
  const addEventListener = context.addEventListener;
  context.addEventListener = (type, listener, ...args) => {
    if (type === 'pageshow') initialPageshow = listener;
    return addEventListener(type, listener, ...args);
  };

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof initialPageshow, 'function');

  initialPageshow();
  await resumeEntered;
  assert.ok(audio.resumeGate);
  assert.equal(vm.runInContext('STREAMING_RESTORE_AUTOPLAY_SETTLEMENT_MS', context), 750);
  f.world.advance(750);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(waveformCalls)), [{
    generation: 4,
    currentPath: restoredTrack.path,
    continuityPath: '',
  }]);
  assert.equal(persistedStates.length, 1);
  assert.equal(persistedStates[0][1].track.path, restoredTrack.path);
  assert.equal(persistedStates[0][1].currentTime, 33);
  assert.equal(persistedStates[0][1].paused, true);
  assert.equal(f.observed.error, null);
  assert.equal(f.observed.settled, true);
  assert.ok(f.observed.role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(f.observed.attempt), true);
  assert.strictEqual(context.streamingEngineState().roles.current, f.observed.role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(previousAttempt), false);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), f.handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(f.handle), true);
  assert.equal(audio.state, 'suspended');
  assert.equal(context.getPlayerPlaybackSnapshot().paused, true);
  assert.equal(context.getPlayerPlaybackSnapshot().currentTime, 33);
  assert.equal(context.state.player.lastRestoreError, undefined);
  assert.equal(context.getLocalStorageItem('albumhaven.playbackOwnership.v1'), f.setupLease);
});

test('restore replaces stale streaming roles on the prepared transport at the saved offset', async (t) => {
  const fixtureCleanups = [];
  const fixtureTest = {
    after(cleanup) { fixtureCleanups.push(cleanup); },
    diagnostic(message) { t.diagnostic(message); },
  };
  t.after(async () => {
    const failures = [];
    // The two independent classic-runtime fixtures install nested globals.
    // Unwind the later active fixture before the earlier paused fixture.
    for (const cleanup of fixtureCleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Prepared restore fixture cleanup failed');
  });
  const streamingCalls = [];
  const restoredTrack = {
    src: '/track?path=restored.flac',
    path: 'C:/Music/restored.flac',
    title: 'Restored Song',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const f = loadRestoreAdmissionHelper(fixtureTest, {
    state: {
      player: {
        current: null,
        playbackQueue: null,
        restoredFromStorage: false,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: restoredTrack,
      playbackQueue: null,
      currentTime: 37.5,
      paused: true,
      loop: { active: false, start: 0, end: 240 },
    }),
    resolveAlbumForPlayerTrack: () => null,
    setLocalStorageItem: () => true,
  });

  const { context } = f;
  const preparedCurrent = await context.startStreamingTrack(restoredTrack, {
    autoplay: false, onStartAttempt() {},
  });
  const preparedAttempt = f.observed.attempt;
  const engine = context.streamingEngineState();
  const scope = context.capturePlaybackOwnershipScope();
  // Original input was a low-level prepared-role pair, not scheduler admission.
  // Allocate through the actual owner without inventing first-frame/PCM evidence.
  const preparedContinuity = context.openStreamingRole('continuity', restoredTrack, 0,
    context.normalizeStreamingContinuityOptions({ kind: 'queued-next' }), preparedAttempt);
  assert.ok(preparedCurrent);
  assert.ok(preparedContinuity);
  assert.strictEqual(engine.roles.current, preparedCurrent);
  assert.strictEqual(engine.roles.continuity, preparedContinuity);
  assert.notEqual(preparedCurrent.streamId, preparedContinuity.streamId);
  assert.equal(preparedCurrent.generation, engine.generation);
  assert.equal(preparedContinuity.generation, engine.generation);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(preparedAttempt), true);
  assert.equal(context.isPlaybackOwnershipScopeCurrent(scope), true);
  assert.equal(context.getActivePlaybackOwnershipHandle(), null);
  assert.equal(engine.context.state, 'suspended');
  assert.equal(engine.socket.readyState, context.WebSocket.CONNECTING);
  assert.equal(engine.snapshot.paused, true);
  assert.equal(engine.pendingSeek, null);
  assert.equal(engine.diagnostics.firstFrameAtMs, 0);
  assert.notEqual(preparedCurrent.firstFrameNotified, true);
  const transport = { context: engine.context, node: engine.node, socket: engine.socket };
  const start = context.startStreamingTrack;
  const stop = context.stopStreamingPlayback;
  context.startStreamingTrack = (track, options) => {
    streamingCalls.push(['start', track, options]);
    return start(track, options);
  };
  context.stopStreamingPlayback = (reason, ...args) => {
    streamingCalls.push(['stop', reason]);
    return stop(reason, ...args);
  };

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    streamingCalls.filter(([type]) => type === 'stop'),
    [],
    'restore must preserve the prepared streaming transport',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(streamingCalls[0])),
    ['start', restoredTrack, { startSeconds: 37.5, autoplay: false }],
    'paused restore lets the engine replace stale roles at the rendered saved offset',
  );

  f.assertAdmission(restoredTrack.path, 37.5);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(preparedAttempt), false);
  assert.notStrictEqual(engine.roles.current, preparedCurrent);
  assert.notStrictEqual(engine.roles.current, preparedContinuity);
  assert.equal(engine.roles.continuity, null);
  assert.strictEqual(engine.context, transport.context);
  assert.strictEqual(engine.node, transport.node);
  assert.strictEqual(engine.socket, transport.socket);
  assert.equal(engine.context.state, 'suspended');
  assert.equal(engine.socket.readyState, context.WebSocket.CONNECTING);
  for (const role of [preparedCurrent, preparedContinuity]) {
    assert.equal(engine.pendingControls.filter(control => control.type === 'close'
      && control.generation === role.generation && control.streamId === role.streamId
      && control.reason === 'replacement').length, 1);
  }

  const playingStreamingCalls = [];
  let initialPageshow = null;
  const playing = loadRestoreAdmissionHelper(fixtureTest, {
    state: {
      player: {
        current: null,
        playbackQueue: null,
        restoredFromStorage: false,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: restoredTrack,
      playbackQueue: null,
      currentTime: 37.5,
      paused: false,
      loop: { active: false, start: 0, end: 240 },
    }),
    resolveAlbumForPlayerTrack: () => null,
    setLocalStorageItem: () => true,
  }, { paused: false });
  const playingContext = playing.context;
  const playingStart = playingContext.startStreamingTrack;
  const playingStop = playingContext.stopStreamingPlayback;
  playingContext.startStreamingTrack = (track, options) => {
    playingStreamingCalls.push(['start', track, options]);
    return playingStart(track, options);
  };
  playingContext.stopStreamingPlayback = (reason, ...args) => {
    playingStreamingCalls.push(['stop', reason]);
    return playingStop(reason, ...args);
  };
  const addEventListener = playingContext.window.addEventListener;
  playingContext.window.addEventListener = (type, listener, ...args) => {
    if (type === 'pageshow') initialPageshow = listener;
    return addEventListener(type, listener, ...args);
  };

  playingContext.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    playingStreamingCalls,
    [],
    'playing restore waits for the initial pageshow before requesting autoplay',
  );
  assert.equal(typeof initialPageshow, 'function');

  initialPageshow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    typeof playingStreamingCalls[0][2].onAutoplayStarted,
    'function',
    'active restore supplies a one-shot autoplay completion callback',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(playingStreamingCalls.map(([type, track, options]) => [
      type,
      track,
      {
        startSeconds: options.startSeconds,
        autoplay: options.autoplay,
        allowSuspendedAutoplayFallback: options.allowSuspendedAutoplayFallback,
      },
    ]))),
    [['start', restoredTrack, {
      startSeconds: 37.5,
      autoplay: true,
      allowSuspendedAutoplayFallback: true,
    }]],
    'initial pageshow requests one restore-only autoplay attempt at the persisted offset',
  );
  playing.assertAdmission(restoredTrack.path, 37.5);
});

test('immediate restore autoplay starts one listen session and persists the playing state once', async (t) => {
  const restoredTrack = {
    src: '/track?path=immediate-autoplay.flac',
    path: 'C:/Music/immediate-autoplay.flac',
    title: 'Immediate Autoplay',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 181,
  };
  const listenSessionCalls = [];
  const persistedStates = [];
  let updateCalls = 0;
  let initialPageshow = null;
  const f = loadPreissuedRestore(t, {
    track: restoredTrack,
    playbackQueue: null,
    currentTime: 37.5,
    paused: false,
    loop: { active: false, start: 0, end: 181 },
  });
  const { context } = f;
  context.beginStreamingPlayerListenSession = (...args) => { listenSessionCalls.push(args); };
  context.setCurrentPlayerTrack = (track) => { context.state.player.current = track; };
  context.updatePlayerUi = () => { updateCalls += 1; };
  const write = context.setLocalStorageItem;
  context.setLocalStorageItem = (key, value) => {
    persistedStates.push([key, JSON.parse(value)]);
    return write(key, value);
  };
  const addEventListener = context.addEventListener;
  context.addEventListener = (type, listener, ...args) => {
    if (type === 'pageshow') initialPageshow = listener;
    return addEventListener(type, listener, ...args);
  };

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));
  initialPageshow();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    JSON.parse(JSON.stringify(listenSessionCalls)),
    [[restoredTrack, 37.5]],
  );
  assert.equal(updateCalls, 2);
  assert.equal(persistedStates.length, 1);
  assert.equal(persistedStates[0][1].paused, false);
  f.assertAdmission(restoredTrack.path, 37.5);
  assert.equal(context.getLocalStorageItem('albumhaven.playbackOwnership.v1'), f.setupLease);
});

test('late restore autoplay completion transitions the persisted fallback once', async (t) => {
  const restoredTrack = {
    src: '/track?path=late-autoplay.flac',
    path: 'C:/Music/late-autoplay.flac',
    title: 'Late Autoplay',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 181,
  };
  const listenSessionCalls = [];
  const persistedStates = [];
  let updateCalls = 0;
  let initialPageshow = null;
  let autoplayStarted = null;
  const f = loadPreissuedRestore(t, {
    track: restoredTrack,
    playbackQueue: null,
    currentTime: 37.5,
    paused: false,
    loop: { active: false, start: 0, end: 181 },
  });
  const { context } = f;
  f.platform.holds.resume = true;
  let signalResumeEntered;
  const resumeEntered = new Promise(resolve => { signalResumeEntered = resolve; });
  f.platform.onContextCreate = audio => {
    const resume = audio.resume;
    audio.resume = function (...args) {
      const work = resume.apply(this, args);
      signalResumeEntered();
      return work;
    };
  };
  let signalAutoplayCompleted;
  const autoplayCompleted = new Promise(resolve => { signalAutoplayCompleted = resolve; });
  const start = context.startStreamingTrack;
  context.startStreamingTrack = (track, options) => {
    autoplayStarted = options.onAutoplayStarted;
    return start(track, { ...options, onAutoplayStarted(...args) {
      const result = autoplayStarted(...args);
      signalAutoplayCompleted();
      return result;
    } });
  };
  context.beginStreamingPlayerListenSession = (...args) => { listenSessionCalls.push(args); };
  context.setCurrentPlayerTrack = (track) => { context.state.player.current = track; };
  context.updatePlayerUi = () => { updateCalls += 1; };
  const write = context.setLocalStorageItem;
  context.setLocalStorageItem = (key, value) => {
    persistedStates.push([key, JSON.parse(value)]);
    return write(key, value);
  };
  const addEventListener = context.addEventListener;
  context.addEventListener = (type, listener, ...args) => {
    if (type === 'pageshow') initialPageshow = listener;
    return addEventListener(type, listener, ...args);
  };

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));
  initialPageshow();
  await resumeEntered;
  const audio = f.platform.contexts[0];
  assert.ok(audio.resumeGate);
  assert.equal(vm.runInContext('STREAMING_RESTORE_AUTOPLAY_SETTLEMENT_MS', context), 750);
  f.world.advance(750);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof autoplayStarted, 'function');
  assert.deepEqual(listenSessionCalls, []);
  assert.equal(updateCalls, 1);
  assert.equal(persistedStates.length, 1);
  assert.equal(persistedStates[0][1].paused, true);
  assert.equal(f.observed.error, null);
  assert.equal(f.observed.settled, true);
  assert.ok(f.observed.role);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(f.observed.attempt), true);
  assert.strictEqual(context.streamingEngineState().roles.current, f.observed.role);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), f.handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(f.handle), true);
  assert.equal(audio.state, 'suspended');
  assert.equal(context.getPlayerPlaybackSnapshot().paused, true);
  assert.equal(context.getPlayerPlaybackSnapshot().currentTime, 37.5);

  audio.state = 'running';
  audio.resumeGate.resolve();
  await autoplayCompleted;
  autoplayStarted();
  autoplayStarted();

  assert.deepEqual(
    JSON.parse(JSON.stringify(listenSessionCalls)),
    [[restoredTrack, 37.5]],
  );
  assert.equal(updateCalls, 2);
  assert.equal(persistedStates.length, 2);
  assert.equal(persistedStates[1][1].paused, false);
  assert.equal(context.getPlayerPlaybackSnapshot().paused, false);
  assert.equal(context.getPlayerPlaybackSnapshot().currentTime, 37.5);
  assert.equal(context.isStreamingPlaybackAttemptCurrent(f.observed.attempt), true);
  assert.strictEqual(context.streamingEngineState().roles.current, f.observed.role);
  assert.strictEqual(context.getActivePlaybackOwnershipHandle(), f.handle);
  assert.equal(context.isPlaybackOwnershipHandleCurrent(f.handle), true);
  assert.equal(context.state.player.lastRestoreError, undefined);
  assert.equal(context.getLocalStorageItem('albumhaven.playbackOwnership.v1'), f.setupLease);
});

test('restore keeps saved loop boundaries but never re-enters loop edit mode', async (t) => {
  const events = [];
  const restoredTrack = {
    src: '/track?path=looped.flac',
    path: 'C:/Music/looped.flac',
    title: 'Looped Song',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 180,
  };
  const { context, assertAdmission } = loadRestoreAdmissionHelper(t, {
    state: {
      player: {
        current: null,
        playbackQueue: null,
        restoredFromStorage: false,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: restoredTrack,
      playbackQueue: null,
      currentTime: 25,
      paused: true,
      loop: { active: true, start: 20, end: 40 },
    }),
    resolveAlbumForPlayerTrack: () => null,
  });

  for (const [name, event] of [
    ['startStreamingTrack', 'start'],
    ['setCurrentPlayerTrack', 'current'],
    ['stopStreamingPlayback', 'stop'],
    ['dispatchActiveStreamingLoop', 'loop'],
  ]) {
    const action = context[name];
    context[name] = (...args) => {
      events.push(event);
      return action(...args);
    };
  }

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['start', 'current']);
  assert.equal(context.state.player.loopActive, false);
  assert.equal(context.state.player.loopStart, 20);
  assert.equal(context.state.player.loopEnd, 40);
  assertAdmission(restoredTrack.path, 25);
});

function loadCapabilityPlayerRestore(actions, paused) {
  const effects = [], events = new Map();
  const track = { src: '/track?path=saved.flac', path: 'saved.flac', title: 'Saved', durationSeconds: 120 };
  const raw = JSON.stringify({ track, currentTime: 17, paused, playbackQueue: null });
  const document = { readyState: 'loading', addEventListener() {}, querySelectorAll: () => [],
    getElementById: id => id === 'capability-bootstrap' ? { textContent: JSON.stringify({ allowed_actions: actions }) } : null };
  const context = loadHelper({ document,
    window: { document, addEventListener: (name, callback) => events.set(name, callback) },
    getLocalStorageItem: () => { effects.push('read'); return raw; },
    canRestoreActivePlayback: () => { effects.push('ownership'); return true; },
    startStreamingTrack: async (_track, options) => { effects.push(['stream', options.autoplay, options.startSeconds]); return { generation: 1, streamId: 1 }; },
    setCurrentPlayerTrack: value => { effects.push('track'); context.state.player.current = value; },
    updatePlayerUi: () => effects.push('render'),
  });
  if (actions !== undefined) vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/capability-ui.js'), 'utf8'), context);
  context.persistPlayerState = () => effects.push('persist');
  return { context, effects, events, track };
}

function loadDeniedCapabilityPlayerRestore(t, actions, paused) {
  const effects = [], events = new Map();
  const track = { src: '/track?path=saved.flac', path: 'saved.flac', title: 'Saved', durationSeconds: 120 };
  const raw = JSON.stringify({ track, currentTime: 17, paused, playbackQueue: null });
  const context = loadUnloadHelper(t, {
    state: { player: { current: null, lastKnownWasPlaying: false, lastPersistedSnapshot: '',
      restoredFromStorage: false, playbackQueue: ['queued'] } },
    getPlayerPlaybackSnapshot: () => ({ src: '', paused: true, ended: false, currentTime: 0, duration: 0 }),
    setLocalStorageItem: () => true,
    flushListenSessionOnUnload: () => {},
  }, { initializeOwnership: false });
  context.document.readyState = 'loading';
  assert.equal(context.document.getElementById('capability-bootstrap'), null);
  const policy = context.document.createElement('script');
  policy.id = 'capability-bootstrap';
  policy.textContent = JSON.stringify({ allowed_actions: actions });
  context.document.body.append(policy);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/capability-ui.js'), 'utf8'), context);
  assert.equal(context.AlbumHavenCapabilities.allows('library.media.read'), false);
  context.getLocalStorageItem = () => { effects.push('read'); return raw; };
  const canRestore = context.canRestoreActivePlayback;
  context.canRestoreActivePlayback = (...args) => { effects.push('ownership'); return canRestore(...args); };
  const start = context.startStreamingTrack;
  context.startStreamingTrack = (value, options) => {
    effects.push(['stream', options.autoplay, options.startSeconds]);
    return start(value, options);
  };
  const setCurrent = context.setCurrentPlayerTrack;
  context.setCurrentPlayerTrack = (...args) => { effects.push('track'); return setCurrent(...args); };
  const addEventListener = context.addEventListener;
  context.addEventListener = (name, callback, ...args) => {
    events.set(name, callback);
    return addEventListener(name, callback, ...args);
  };
  context.updatePlayerUi = () => effects.push('render');
  context.persistPlayerState = () => effects.push('persist');
  return { context, effects, events, track };
}

for (const paused of [true, false]) for (const actions of [{ 'library.media.read': false }, {}]) {
  test(`denied saved ${paused ? 'paused' : 'playing'} track cannot restore state or claim ownership (${Object.keys(actions).length ? 'denied' : 'missing grant'})`, async (t) => {
    const f = loadDeniedCapabilityPlayerRestore(t, actions, paused);
    const player = f.context.state.player;
    assert.strictEqual(player, vm.runInContext('state.player', f.context));
    const before = JSON.stringify(f.context.state.player);
    f.context.restorePlayerState();
    f.events.get('pageshow')?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, []);
    assert.equal(JSON.stringify(f.context.state.player), before);
    assert.equal(f.events.has('pageshow'), false);
    assert.strictEqual(f.context.state.player, player);
    assert.strictEqual(player, vm.runInContext('state.player', f.context));
  });
}

function loadAdmissionCapabilityPlayerRestore(t, actions, paused) {
  const effects = [], events = new Map();
  const track = { src: '/track?path=saved.flac', path: 'saved.flac', title: 'Saved', durationSeconds: 120 };
  const raw = JSON.stringify({ track, currentTime: 17, paused, playbackQueue: null });
  const f = loadRestoreAdmissionHelper(t, {
    state: { player: { current: null, lastKnownWasPlaying: false, lastPersistedSnapshot: '',
      restoredFromStorage: false, playbackQueue: ['queued'] } },
    getLocalStorageItem: () => raw,
  }, { paused });
  const { context } = f;
  context.document.readyState = 'loading';
  assert.equal(context.document.getElementById('capability-bootstrap'), null);
  assert.equal(context.AlbumHavenCapabilities, undefined);
  if (actions !== undefined) {
    const policy = context.document.createElement('script');
    policy.id = 'capability-bootstrap';
    policy.textContent = JSON.stringify({ allowed_actions: actions });
    context.document.body.append(policy);
    vm.runInContext(fs.readFileSync(path.join(__dirname,
      '../../../music_app/static/js/capability-ui.js'), 'utf8'), context);
    assert.equal(context.AlbumHavenCapabilities.allows('library.media.read'), true);
  }
  const read = context.getLocalStorageItem;
  context.getLocalStorageItem = key => {
    if (key === 'albumhaven.playerState.v1') effects.push('read');
    return read(key);
  };
  const canRestore = context.canRestoreActivePlayback;
  context.canRestoreActivePlayback = (...args) => { effects.push('ownership'); return canRestore(...args); };
  const start = context.startStreamingTrack;
  context.startStreamingTrack = (value, options) => {
    effects.push(['stream', options.autoplay, options.startSeconds]);
    return start(value, options);
  };
  for (const [name, effect] of [['setCurrentPlayerTrack', 'track'], ['updatePlayerUi', 'render'], ['persistPlayerState', 'persist']]) {
    const owner = context[name];
    context[name] = (...args) => { effects.push(effect); return owner(...args); };
  }
  const addEventListener = context.addEventListener;
  context.addEventListener = (name, callback, ...args) => {
    events.set(name, callback);
    return addEventListener(name, callback, ...args);
  };
  return { ...f, effects, events, track };
}

for (const paused of [true, false]) for (const actions of [{ 'library.media.read': true }, undefined]) {
  test(`saved ${paused ? 'paused' : 'playing'} track retains existing restore timing (${actions ? 'granted' : 'legacy'})`, async (t) => {
    const f = loadAdmissionCapabilityPlayerRestore(t, actions, paused);
    f.context.restorePlayerState();
    assert.equal(f.events.has('pageshow'), !paused);
    if (!paused) {
      assert.equal(f.effects.some(effect => Array.isArray(effect) && effect[0] === 'stream'), false);
      f.events.get('pageshow')();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects.filter(Array.isArray), [['stream', !paused, 17]]);
    assert.equal(f.effects.includes('ownership'), !paused);
    assert.equal(f.context.state.player.current.path, f.track.path);
    assert.equal(f.context.state.player.restoredFromStorage, true);
    assert.equal(f.context.state.player.playbackQueue, null);
    f.assertAdmission(f.track.path, 17);
    if (!paused) assert.equal(f.observed.writes.length, 1, 'full claim integration saves the restored player state once');
  });
}

test('bootstrap attach cannot restore denied media before the later engine preparation guard', async () => {
  const f = loadCapabilityPlayerRestore({ 'library.media.read': false }, false);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/player-loop-playback.js'), 'utf8'), f.context);
  f.context.getPlayerElements = () => ({});
  f.context.setCurrentPlayerTrack = value => { assert.equal(value, null); };
  f.context.updatePlayerUi = () => {};
  for (const name of ['restorePlayerAppearance', 'attachModalEvents', 'attachAccountMenu', 'attachCoverLookupModalEvents',
    'attachCoverLookupDeleteConfirmEvents', 'attachUtilityModalEvents', 'attachRepairConfirmEvents']) f.context[name] = () => {};
  const attach = f.context.attachPlayerEvents;
  const order = [];
  f.context.attachPlayerEvents = () => { order.push('attach'); attach(); };
  f.context.initPlaybackOwnershipCoordinator = () => order.push('coordinator');
  f.context.prepareStreamingPlaybackEngine = () => { assert.fail('denied media must not prepare the engine'); };
  const bootstrap = fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/bootstrap-init.js'), 'utf8');
  vm.runInContext(bootstrap.slice(0, bootstrap.indexOf('const bootstrapSearchParams')), f.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['attach', 'coordinator']);
  assert.deepEqual(f.effects, []);
  assert.equal(f.context.state.player.restoredFromStorage, false);
});

function receiptUnit(write) {
  const track = { src: '/track?path=receipt.flac', path: 'receipt.flac', title: 'Receipt', durationSeconds: 90 };
  const playback = { src: track.src, paused: false, ended: false, currentTime: 12, duration: 90 };
  const context = loadHelper({
    state: { player: { current: track, playbackQueue: null, lastKnownWasPlaying: true, lastPersistedSnapshot: '' } },
    getPlayerPlaybackSnapshot: () => ({ ...playback }),
    setLocalStorageItem: write,
  });
  return { context, playback };
}

test('receipt: only a confirmed snapshot write returns true and publishes cache', () => {
  const writes = [];
  const { context } = receiptUnit((key, value) => { writes.push([key, value]); return true; });
  assert.equal(context.persistPlayerState(true), true);
  assert.equal(writes.length, 1);
  assert.equal(context.state.player.lastPersistedSnapshot, writes[0][1]);
});

for (const outcome of ['false', 'void', 'throw']) {
  test(`receipt: ${outcome} storage leaves the previously confirmed cache unchanged`, () => {
    let calls = 0;
    const { context } = receiptUnit(() => {
      calls += 1;
      if (outcome === 'throw') throw new Error('synthetic storage failure');
      return outcome === 'false' ? false : undefined;
    });
    context.state.player.lastPersistedSnapshot = 'previous confirmed snapshot';
    assert.doesNotThrow(() => { assert.equal(context.persistPlayerState(true), false); });
    assert.equal(calls, 1);
    assert.equal(context.state.player.lastPersistedSnapshot, 'previous confirmed snapshot');
  });
}

for (const unavailable of ['absent', 'throwing']) {
  test(`receipt: actual browser storage wrapper reports ${unavailable} storage without cache advancement`, () => {
    const { context } = receiptUnit(() => { assert.fail('the original unit write seam must be replaced'); });
    context.window = unavailable === 'absent' ? {} : { localStorage: {
      setItem() { throw new Error('synthetic native quota failure'); },
    } };
    vm.runInContext(fs.readFileSync(path.join(__dirname,
      '../../../music_app/static/js/runtime/browser-storage-helpers.js'), 'utf8'), context);
    assert.equal(context.persistPlayerState(true), false);
    assert.equal(context.state.player.lastPersistedSnapshot, '');
  });
}

test('receipt: cache skip is not a write receipt and changed nonforced state is not time-throttled', () => {
  const writes = [];
  const { context, playback } = receiptUnit((_key, value) => { writes.push(value); return true; });
  assert.equal(context.persistPlayerState(false), true);
  assert.equal(context.persistPlayerState(false), false);
  playback.currentTime = 13;
  assert.equal(context.persistPlayerState(false), true);
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1]).currentTime, 13);
});

test('receipt: identical explicit force saves each attempt storage', () => {
  let calls = 0;
  const { context } = receiptUnit(() => { calls += 1; return true; });
  assert.equal(context.persistPlayerState(true), true);
  assert.equal(context.persistPlayerState(true), true);
  assert.equal(calls, 2);
});

test('receipt: equal cached state cannot turn a failed forced write into success or suppress forced retry', () => {
  let calls = 0;
  const { context } = receiptUnit(() => ++calls > 1);
  const confirmed = JSON.stringify(context.buildPersistedPlayerState());
  context.state.player.lastPersistedSnapshot = confirmed;
  assert.equal(context.persistPlayerState(true), false);
  assert.equal(context.state.player.lastPersistedSnapshot, confirmed);
  assert.equal(context.persistPlayerState(true), true);
  assert.equal(calls, 2);
});

test('receipt: absent payload preserves removal behavior but produces no snapshot-write receipt', () => {
  const { context } = receiptUnit(() => { assert.fail('absent player cannot write a snapshot'); });
  context.state.player.current = null;
  context.state.player.lastPersistedSnapshot = 'previous';
  const removed = [];
  context.removeLocalStorageItem = key => { removed.push(key); return true; };
  assert.equal(context.persistPlayerState(true), false);
  assert.deepEqual(removed, ['albumhaven.playerState.v1']);
  assert.equal(context.state.player.lastPersistedSnapshot, '');
});

test('receipt: real unload latch blocks later saves without issuing success', (t) => {
  const writes = [];
  const track = { src: '/track?path=unload-receipt.flac', path: 'unload-receipt.flac', title: 'Unload' };
  const context = loadUnloadHelper(t, {
    state: { player: { current: track, lastKnownWasPlaying: true, lastPersistedSnapshot: '' } },
    getPlayerPlaybackSnapshot: () => ({ src: track.src, paused: false, ended: false, currentTime: 4, duration: 90 }),
    setLocalStorageItem: (_key, value) => { writes.push(value); return true; },
    flushListenSessionOnUnload: () => {},
  });
  assert.equal(context.persistPlayerStateForUnload('pagehide'), true);
  assert.equal(context.persistPlayerState(true), false);
  assert.equal(writes.length, 1);
});

function writeRegressionRestore(t) {
  const saved = {
    track: { src: '/track?path=write-regression.flac', path: 'write-regression.flac', title: 'Write regression', durationSeconds: 181 },
    playbackQueue: null, currentTime: 37.5, paused: false, loop: { active: false, start: 0, end: 181 },
  };
  const f = loadPreissuedRestore(t, saved), { context } = f;
  const writes = [], receipts = [], listens = [];
  let pageshow, autoplay, uiCalls = 0;
  const hooks = { ui() {}, persisted() {}, write: null };
  context.setCurrentPlayerTrack = track => { context.state.player.current = track; };
  context.beginStreamingPlayerListenSession = (...args) => { listens.push(args); };
  context.updatePlayerUi = () => { uiCalls += 1; hooks.ui(uiCalls); };
  const write = context.setLocalStorageItem;
  context.setLocalStorageItem = (key, value) => {
    writes.push({ key, value: JSON.parse(value) });
    return hooks.write ? hooks.write(key, value, () => write(key, value)) : write(key, value);
  };
  const persist = context.persistPlayerState;
  context.persistPlayerState = (...args) => {
    const result = persist(...args);
    receipts.push({ force: args[0] === true, result, cache: context.state.player.lastPersistedSnapshot });
    hooks.persisted(receipts.at(-1), receipts.length);
    return result;
  };
  const add = context.addEventListener;
  context.addEventListener = (name, callback, ...args) => {
    if (name === 'pageshow') pageshow = callback;
    return add(name, callback, ...args);
  };
  const start = context.startStreamingTrack;
  context.startStreamingTrack = (track, options) => {
    autoplay = options.onAutoplayStarted;
    return start(track, options);
  };
  async function run() {
    context.restorePlayerState();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof pageshow, 'function');
    pageshow();
    await new Promise(resolve => setImmediate(resolve));
  }
  return { ...f, saved, writes, receipts, listens, hooks, run,
    uiCalls: () => uiCalls, autoplay: () => { assert.equal(typeof autoplay, 'function'); autoplay(); } };
}

test('restore receipt: immediate identical completion and tail save once after real admission', async (t) => {
  const f = writeRegressionRestore(t);
  await f.run();
  f.assertAdmission(f.saved.track.path, 37.5);
  assert.equal(f.listens.length, 1);
  assert.equal(f.uiCalls(), 2);
  assert.deepEqual(f.writes.map(row => row.key), ['albumhaven.playerState.v1']);
  assert.equal(f.writes[0].value.paused, false);
  assert.deepEqual(f.receipts.map(row => [row.force, row.result]), [[true, true], [false, false]]);
});

test('restore receipt: changed tail payload still saves after successful completion', async (t) => {
  const f = writeRegressionRestore(t);
  f.hooks.persisted = (_receipt, count) => { if (count === 1) f.context.state.player.loopEnd = 150; };
  await f.run();
  f.assertAdmission(f.saved.track.path, 37.5);
  assert.deepEqual(f.writes.map(row => row.key), ['albumhaven.playerState.v1', 'albumhaven.playerState.v1']);
  assert.deepEqual(f.writes.map(row => row.value.loop.end), [181, 150]);
  assert.deepEqual(f.receipts.map(row => [row.force, row.result]), [[true, true], [false, true]]);
});

for (const outcome of ['false', 'void', 'throw']) {
  test(`restore receipt: ${outcome} completion write leaves tail forced and retryable`, async (t) => {
    const f = writeRegressionRestore(t), tailCaches = [];
    let attempts = 0;
    f.hooks.write = (key, _value, commit) => {
      assert.equal(key, 'albumhaven.playerState.v1');
      if (++attempts === 1) {
        if (outcome === 'throw') throw new Error('synthetic completion write failure');
        return outcome === 'false' ? false : undefined;
      }
      return commit();
    };
    f.hooks.persisted = (receipt, count) => { if (count === 1) tailCaches.push(receipt.cache); };
    await f.run();
    f.assertAdmission(f.saved.track.path, 37.5);
    assert.equal(f.context.state.player.lastRestoreError, undefined);
    assert.deepEqual(tailCaches, ['']);
    assert.equal(attempts, 2);
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.receipts.map(row => [row.force, row.result]), [[true, false], [true, true]]);
    assert.equal(JSON.parse(f.context.getLocalStorageItem('albumhaven.playerState.v1')).paused, false);
  });
}

test('restore receipt: genuine suspended fallback and late resume preserve both transitions exactly once', async (t) => {
  const f = writeRegressionRestore(t);
  f.platform.holds.resume = true;
  await f.run();
  assert.equal(f.observed.settled, false);
  assert.ok(f.platform.contexts[0].resumeGate);
  f.world.advance(750);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.observed.settled, true);
  assert.equal(f.context.isStreamingPlaybackAttemptCurrent(f.observed.attempt), true);
  assert.strictEqual(f.context.streamingEngineState().roles.current, f.observed.role);
  assert.deepEqual(f.writes.map(row => row.value.paused), [true]);
  assert.equal(f.listens.length, 0);
  f.platform.contexts[0].state = 'running';
  f.platform.contexts[0].resumeGate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  f.autoplay();
  f.autoplay();
  assert.deepEqual(f.writes.map(row => row.key), ['albumhaven.playerState.v1', 'albumhaven.playerState.v1']);
  assert.deepEqual(f.writes.map(row => row.value.paused), [true, false]);
  assert.deepEqual(f.receipts.map(row => [row.force, row.result]), [[true, true], [true, true]]);
  assert.equal(f.listens.length, 1);
  assert.equal(f.context.getPlayerPlaybackSnapshot().paused, false);
  assert.strictEqual(f.context.getActivePlaybackOwnershipHandle(), f.handle);
});

for (const retirement of ['scope', 'restore']) {
  test(`restore receipt: ${retirement} retirement after completion prevents a stale tail save`, async (t) => {
    const f = writeRegressionRestore(t);
    f.hooks.persisted = (_receipt, count) => {
      if (count !== 1) return;
      if (retirement === 'scope') {
        f.context.document.getElementById('app-shell').dataset.privateUiContext = 'b'.repeat(64);
        f.context.capturePlaybackOwnershipScope();
      } else f.context.retirePlayerRestoreAttempt('synthetic manual retirement');
    };
    await f.run();
    assert.deepEqual(f.writes.map(row => row.key), ['albumhaven.playerState.v1']);
    assert.equal(f.writes[0].value.paused, false);
    assert.equal(f.receipts.length, 1);
    assert.equal(f.receipts[0].result, true);
    assert.equal(f.context.isStreamingPlaybackAttemptCurrent(f.observed.attempt), false);
    assert.notStrictEqual(f.context.getActivePlaybackOwnershipHandle(), f.handle);
    assert.equal(f.context.state.player.lastRestoreError, undefined);
  });
}

for (const invalid of ['changed-track', 'changed-scope', 'expired-lease', 'foreign-lease', 'retired-caller']) {
  test(`preissued provider: ${invalid} cannot hand off the real reserved claim`, (t) => {
    const saved = { track: { src: '/track?path=provider.flac', path: 'provider.flac', title: 'Provider', durationSeconds: 90 },
      playbackQueue: null, currentTime: 7, paused: false };
    const f = loadPreissuedRestore(t, saved), { context } = f;
    context.restorePlayerState();
    const restore = vm.runInContext('playerRestoreAttempt', context);
    assert.ok(restore?.pageshow);
    let parsed = saved;
    if (invalid === 'changed-track') parsed = { ...saved, track: { ...saved.track, title: 'Different title' } };
    if (invalid === 'changed-scope') {
      context.document.getElementById('app-shell').dataset.privateUiContext = 'b'.repeat(64);
      context.capturePlaybackOwnershipScope();
    }
    if (invalid === 'expired-lease') f.world.advance(15001);
    if (invalid === 'foreign-lease') context.localStorage.setItem('albumhaven.playbackOwnership.v1', JSON.stringify({
      tab_id: 'foreign-provider-successor', claim_revision: 91, status: 'playing', reason: 'manual_start',
      updated_at_ms: f.world.now(), expires_at_ms: f.world.now() + 15000,
    }));
    if (invalid === 'retired-caller') context.retirePlayerRestoreAttempt('provider negative input');
    const before = context.getLocalStorageItem('albumhaven.playbackOwnership.v1');
    assert.equal(context.canRestoreActivePlayback(parsed, { isCurrent: () => context.currentPlayerRestoreAttempt(restore) }), false);
    assert.equal(context.getLocalStorageItem('albumhaven.playbackOwnership.v1'), before);
    assert.equal(context.streamingEngineState().roles.current, null);
    assert.equal(f.platform.contexts.length, 0);
    context.retirePlayerRestoreAttempt('provider negative cleanup');
  });
}

test('receipt: cache publication failure cannot issue a successful write receipt', () => {
  let writes = 0;
  const { context } = receiptUnit(() => { writes += 1; return true; });
  Object.defineProperty(context.state.player, 'lastPersistedSnapshot', {
    configurable: true, get: () => 'previous confirmed snapshot',
    set() { throw new Error('synthetic cache publication failure'); },
  });
  assert.equal(context.persistPlayerState(true), false);
  assert.equal(writes, 1);
  assert.equal(context.state.player.lastPersistedSnapshot, 'previous confirmed snapshot');
});

test('restore receipt: failed completion with an already equal cache still forces the tail retry', async (t) => {
  const f = writeRegressionRestore(t);
  const confirmed = JSON.stringify({
    track: { src: f.saved.track.src, path: f.saved.track.path, title: f.saved.track.title,
      artist: '', album: '', coverPath: '', durationSeconds: 181 },
    playbackQueue: null, currentTime: 37.5, paused: false, loop: { active: false, start: 0, end: 181 },
  });
  f.context.state.player.lastPersistedSnapshot = confirmed;
  let attempts = 0;
  f.hooks.write = (_key, value, commit) => {
    assert.equal(value, confirmed);
    return ++attempts === 1 ? false : commit();
  };
  await f.run();
  f.assertAdmission(f.saved.track.path, 37.5);
  assert.equal(attempts, 2);
  assert.deepEqual(f.receipts.map(row => [row.force, row.result]), [[true, false], [true, true]]);
});
