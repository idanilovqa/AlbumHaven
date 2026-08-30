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

test('album artist and album snapshot survive streaming persistence and restore', async () => {
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
  const restoreContext = loadHelper({
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
    setCurrentPlayerTrack: (track) => restoredTracks.push(track),
    setLocalStorageItem: () => true,
  });

  restoreContext.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(restoredTracks[0].albumArtist, 'Various Artists');
  assert.equal(restoredTracks[0].durationSeconds, 30);
  assert.equal(restoreContext.state.player.playbackQueue.albumRef, albumSnapshot.key);
  assert.deepEqual(
    JSON.parse(JSON.stringify(restoreContext.state.player.playbackQueue.albumSnapshot)),
    albumSnapshot,
  );
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

test('paired unload events preserve the first rendered snapshot exactly once', () => {
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
  const context = loadHelper({
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
  context.releasePlaybackOwnership = () => {
    releaseCalls += 1;
    context.state.player.lastKnownWasPlaying = false;
    context.persistPlayerState();
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

test('unload preserves the rendered playhead before playback ownership teardown', () => {
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
  const context = loadHelper({
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
  context.releasePlaybackOwnership = () => {
    playback.paused = true;
    playback.currentTime = 0;
  };

  context.persistPlayerStateForUnload('pagehide');
  context.persistPlayerState(true, { preservePlayingState: true });

  assert.equal(storedSnapshots.length, 1);
  assert.equal(storedSnapshots[0].currentTime, 37.25);
  assert.equal(storedSnapshots[0].paused, false);
});

test('BFCache restoration re-enables normal player-state persistence after pagehide', () => {
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
  const context = loadHelper({
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
  context.releasePlaybackOwnership = () => {};

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

test('restore normalizes a persisted queue before opening the fresh streaming role', async () => {
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
  const context = loadHelper({
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
  });

  context.restorePlayerState();
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
});

test('restore refreshes a stale album snapshot while preserving queue order', async () => {
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
  const context = loadHelper({
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
    setCurrentPlayerTrack: (track) => {
      calls.setCurrentPlayerTrack.push(track);
    },
    setLocalStorageItem: () => true,
  });

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
});

test('restore clears a missing persisted queue', async () => {
  const context = loadHelper({
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
    setLocalStorageItem: () => true,
  });

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(context.state.player.playbackQueue, null);
});
test('restore honors ownership denial by keeping a saved playing track suspended', async () => {
  const calls = {
    startStreamingTrack: [],
    setCurrentPlayerTrack: [],
    updatePlayerUi: 0,
  };
  const context = loadHelper({
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
  });

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.startStreamingTrack[0])),
    [
      JSON.parse(JSON.stringify(calls.setCurrentPlayerTrack[0])),
      { startSeconds: 12, autoplay: false },
    ],
  );
  assert.equal(calls.updatePlayerUi, 1);
});

test('restore exposes the full persisted track before browser audio startup can resume', () => {
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
  const context = loadHelper({
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
  });

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

test('paused restore requests waveform peaks after the restored streaming role is current', async () => {
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
  const context = loadHelper({
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
    startStreamingTrack: () => Promise.resolve({ generation: 8, streamId: 81 }),
    setCurrentPlayerTrack: (track) => { context.state.player.current = track; },
    handleStreamingPlaybackWaveformReady: (event) => {
      waveformCalls.push(event);
      return Promise.resolve();
    },
    resolveAlbumForPlayerTrack: () => null,
    setLocalStorageItem: () => true,
  });

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(waveformCalls)), [{
    generation: 8,
    currentPath: restoredTrack.path,
    continuityPath: '',
  }]);
});

test('blocked active restore reconciles waveform and persists the retained paused role', async () => {
  const waveformCalls = [];
  const persistedStates = [];
  let initialPageshow = null;
  let playbackCurrentTime = 0;
  const restoredTrack = {
    src: '/track?path=blocked-restore.flac',
    path: 'C:/Music/blocked-restore.flac',
    title: 'Blocked Restore',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
    durationSeconds: 181,
  };
  const context = loadHelper({
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
      loop: { active: false, start: 0, end: 181 },
    }),
    getPlayerPlaybackSnapshot: () => ({
      src: restoredTrack.src,
      paused: true,
      ended: false,
      currentTime: playbackCurrentTime,
      duration: 181,
    }),
    startStreamingTrack: () => {
      playbackCurrentTime = 33;
      return Promise.resolve({ generation: 4, streamId: 41 });
    },
    setCurrentPlayerTrack: (track) => { context.state.player.current = track; },
    handleStreamingPlaybackWaveformReady: (event) => {
      waveformCalls.push(event);
      return Promise.resolve();
    },
    setLocalStorageItem: (key, value) => {
      persistedStates.push([key, JSON.parse(value)]);
      return true;
    },
    window: {
      addEventListener: (type, listener) => {
        if (type === 'pageshow') initialPageshow = listener;
      },
    },
    resolveAlbumForPlayerTrack: () => null,
  });

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof initialPageshow, 'function');

  initialPageshow();
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
});

test('restore replaces stale streaming roles on the prepared transport at the saved offset', async () => {
  const streamingCalls = [];
  const restoredTrack = {
    src: '/track?path=restored.flac',
    path: 'C:/Music/restored.flac',
    title: 'Restored Song',
    artist: 'Artist',
    album: 'Album',
    coverPath: '',
  };
  const context = loadHelper({
    state: {
      player: {
        current: null,
        playbackQueue: null,
        restoredFromStorage: false,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
        streaming: {
          generation: 7,
          roles: {
            current: { generation: 7, streamId: 71 },
            continuity: { generation: 7, streamId: 72 },
          },
        },
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: restoredTrack,
      playbackQueue: null,
      currentTime: 37.5,
      paused: true,
      loop: { active: false, start: 0, end: 240 },
    }),
    stopStreamingPlayback: (reason) => {
      streamingCalls.push(['stop', reason]);
      return Promise.resolve();
    },
    startStreamingTrack: (track, options) => {
      streamingCalls.push(['start', track, options]);
      return Promise.resolve({ generation: 8, streamId: 81 });
    },
    resolveAlbumForPlayerTrack: () => null,
    setLocalStorageItem: () => true,
  });

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

  const playingStreamingCalls = [];
  let initialPageshow = null;
  const playingContext = loadHelper({
    state: {
      player: {
        current: null,
        playbackQueue: null,
        restoredFromStorage: false,
        lastKnownWasPlaying: false,
        lastPersistedSnapshot: '',
        streaming: { generation: 0, roles: { current: null, continuity: null } },
      },
    },
    getLocalStorageItem: () => JSON.stringify({
      track: restoredTrack,
      playbackQueue: null,
      currentTime: 37.5,
      paused: false,
      loop: { active: false, start: 0, end: 240 },
    }),
    stopStreamingPlayback: (reason) => {
      playingStreamingCalls.push(['stop', reason]);
      return Promise.resolve();
    },
    startStreamingTrack: (track, options) => {
      playingStreamingCalls.push(['start', track, options]);
      return Promise.resolve({ generation: 1, streamId: 11 });
    },
    window: {
      addEventListener: (type, listener) => {
        if (type === 'pageshow') initialPageshow = listener;
      },
    },
    resolveAlbumForPlayerTrack: () => null,
    setLocalStorageItem: () => true,
  });

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
});

test('immediate restore autoplay starts one listen session and persists the playing state once', async () => {
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
  let playbackPaused = true;
  const context = loadHelper({
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
      loop: { active: false, start: 0, end: 181 },
    }),
    getPlayerPlaybackSnapshot: () => ({
      src: restoredTrack.src,
      paused: playbackPaused,
      ended: false,
      currentTime: 37.5,
      duration: 181,
    }),
    startStreamingTrack: (track, options) => {
      playbackPaused = false;
      options.onAutoplayStarted();
      return Promise.resolve({ generation: 1, streamId: 11 });
    },
    beginStreamingPlayerListenSession: (...args) => { listenSessionCalls.push(args); },
    setCurrentPlayerTrack: (track) => { context.state.player.current = track; },
    updatePlayerUi: () => { updateCalls += 1; },
    setLocalStorageItem: (key, value) => {
      persistedStates.push([key, JSON.parse(value)]);
      return true;
    },
    window: {
      addEventListener: (type, listener) => {
        if (type === 'pageshow') initialPageshow = listener;
      },
    },
    resolveAlbumForPlayerTrack: () => null,
  });

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
});

test('late restore autoplay completion transitions the persisted fallback once', async () => {
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
  let playbackPaused = true;
  let autoplayStarted = null;
  const context = loadHelper({
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
      loop: { active: false, start: 0, end: 181 },
    }),
    getPlayerPlaybackSnapshot: () => ({
      src: restoredTrack.src,
      paused: playbackPaused,
      ended: false,
      currentTime: 37.5,
      duration: 181,
    }),
    startStreamingTrack: (track, options) => {
      autoplayStarted = options.onAutoplayStarted;
      return Promise.resolve({ generation: 1, streamId: 11 });
    },
    beginStreamingPlayerListenSession: (...args) => { listenSessionCalls.push(args); },
    setCurrentPlayerTrack: (track) => { context.state.player.current = track; },
    updatePlayerUi: () => { updateCalls += 1; },
    setLocalStorageItem: (key, value) => {
      persistedStates.push([key, JSON.parse(value)]);
      return true;
    },
    window: {
      addEventListener: (type, listener) => {
        if (type === 'pageshow') initialPageshow = listener;
      },
    },
    resolveAlbumForPlayerTrack: () => null,
  });

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));
  initialPageshow();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof autoplayStarted, 'function');
  assert.deepEqual(listenSessionCalls, []);
  assert.equal(updateCalls, 1);
  assert.equal(persistedStates.length, 1);
  assert.equal(persistedStates[0][1].paused, true);

  playbackPaused = false;
  autoplayStarted();
  autoplayStarted();

  assert.deepEqual(
    JSON.parse(JSON.stringify(listenSessionCalls)),
    [[restoredTrack, 37.5]],
  );
  assert.equal(updateCalls, 2);
  assert.equal(persistedStates.length, 2);
  assert.equal(persistedStates[1][1].paused, false);
});

test('restore keeps saved loop boundaries but never re-enters loop edit mode', async () => {
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
  const context = loadHelper({
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
    stopStreamingPlayback: () => {
      events.push('stop');
      return Promise.resolve();
    },
    startStreamingTrack: () => {
      events.push('start');
      return Promise.resolve({ generation: 3, streamId: 31 });
    },
    setCurrentPlayerTrack: (track) => {
      context.state.player.current = track;
      context.state.player.loopActive = false;
      context.state.player.loopStart = 0;
      context.state.player.loopEnd = Number(track.durationSeconds) || 0;
      events.push('current');
    },
    dispatchActiveStreamingLoop: () => { events.push('loop'); },
    resolveAlbumForPlayerTrack: () => null,
    setLocalStorageItem: () => true,
  });

  context.restorePlayerState();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['start', 'current']);
  assert.equal(context.state.player.loopActive, false);
  assert.equal(context.state.player.loopStart, 20);
  assert.equal(context.state.player.loopEnd, 40);
});
