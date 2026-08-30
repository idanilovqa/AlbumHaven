const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  'playback-ownership-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelper(overrides = {}) {
  const stopStreamingPlaybackCalls = [];
  const context = {
    state: {
      player: {
        current: null,
        ownership: {
          tabId: 'local-tab',
          lockStatus: 'unlocked',
          blockedReason: '',
          mirroredTrack: null,
          activeClaim: null,
          channel: null,
          heartbeatTimer: 0,
          initialized: true,
        },
      },
    },
    window: {},
    getLocalStorageItem: () => '',
    setLocalStorageItem: () => true,
    updatePlayerUi: () => {},
    stopStreamingPlayback: (reason) => {
      stopStreamingPlaybackCalls.push(reason);
    },
    clearInterval: () => {},
    setInterval: () => 0,
    showToast: () => {},
    console,
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, stopStreamingPlaybackCalls };
}

{
  let updateCalls = 0;
  const { context, stopStreamingPlaybackCalls } = loadHelper({
    updatePlayerUi: () => {
      updateCalls += 1;
    },
  });
  const remoteTrack = {
    src: '/track?path=remote.flac',
    path: 'C:/Music/remote.flac',
    title: 'Remote Track',
    artist: 'Remote Artist',
    album: 'Remote Album',
    coverPath: '',
  };

  context.syncMirroredPlaybackState({
    tab_id: 'remote-tab',
    status: 'playing',
    updated_at_ms: Date.now(),
    expires_at_ms: Date.now() + 10000,
    track: remoteTrack,
  });

  assert.deepEqual(
    stopStreamingPlaybackCalls,
    ['ownership-takeover'],
    'a remote owner closes the local streaming generation and both of its roles',
  );
  assert.equal(context.state.player.ownership.lockStatus, 'locked');
  assert.equal(context.state.player.ownership.blockedReason, 'playing_in_another_tab');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.player.ownership.mirroredTrack)),
    {
      ...remoteTrack,
      trackNumber: '',
    },
  );
  assert.equal(updateCalls, 1);
}
