const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..', '..');

function readRuntime(name) {
  return fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', name), 'utf8');
}

test('bottom-player runtime state contains no native audio or preload ownership', () => {
  const source = readRuntime('core-state-and-helpers.js');
  for (const obsolete of [
    'activeAudioId',
    'preloadedTrack',
    'preloadTriggeredForTrackPath',
    'preloadReady',
    'pendingRestorePlayback',
    'audioContext',
    'dataBySrc',
    'loadingSrc',
    'speed: 1',
  ]) {
    assert.equal(source.includes(obsolete), false, `obsolete bottom-player state remains: ${obsolete}`);
  }
});

test('live runtime sources contain no native bottom-player helpers or fallback controls', () => {
  const expectations = new Map([
    ['player-and-waveform.js', [
      'getPlayerAudioById',
      'getPrimaryPlayerAudio',
      'getPreloadPlayerAudio',
      'getActivePlayerAudio',
      'getInactivePlayerAudio',
      'resetPlayerAudioElement',
      'clearPreloadedNextTrack',
      'clearPendingRestorePlayback',
      'attemptRestorePlayback',
    ]],
    ['tag-editor-and-optimistic-updates.js', [
      'maybePreloadNextQueuedTrack',
      'activatePreloadedTrack',
      'preloadedTrack',
      'preloadReady',
    ]],
    ['bootstrap-init.js', ['attemptRestorePlayback', 'getActivePlayerAudio']],
    ['playback-ownership-helpers.js', ['getActivePlayerAudio', 'pendingRestorePlayback']],
    ['player-state-persistence-helpers.js', [
      'clearPreloadedNextTrack',
      'clearPendingRestorePlayback',
      'pendingRestorePlayback',
      'setPlayerSpeed',
      'attemptRestorePlayback',
    ]],
  ]);
  for (const [name, obsoleteSymbols] of expectations) {
    const source = readRuntime(name);
    for (const symbol of obsoleteSymbols) {
      assert.equal(source.includes(symbol), false, `${name} retains ${symbol}`);
    }
  }
});

test('bottom-player event wiring has no native queue, media-event, or speed path', () => {
  const source = readRuntime('player-loop-playback.js');
  for (const obsolete of [
    'setPlayerSpeed',
    'getPrimaryPlayerAudio',
    'getPreloadPlayerAudio',
    'getInactivePlayerAudio',
    'getActivePlayerAudio',
    'maybePreloadNextQueuedTrack',
    'activatePreloadedTrack',
    "addEventListener('ended'",
    "addEventListener('timeupdate'",
    "addEventListener('loadedmetadata'",
  ]) {
    assert.equal(source.includes(obsolete), false, `native player-loop path remains: ${obsolete}`);
  }
});

test('saved-loop utility playback keeps its independent native audio control', () => {
  const source = readRuntime('utility-loop-playback.js');
  assert.match(source, /data-loop-audio/);
  assert.match(source, /audio\.play\(\)/);
  assert.match(source, /audio\.pause\(\)/);
});
