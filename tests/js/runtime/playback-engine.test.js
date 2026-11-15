const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimeDir = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const contractSource = fs.readFileSync(path.join(runtimeDir, 'playback-engine.js'), 'utf8');

const OPERATIONS = {
  pause: ['pauseStreamingPlayback', []],
  resume: ['resumeStreamingPlayback', [7, 'started', 'role']],
  seek: ['seekStreamingPlayback', [42]],
  continuity: ['scheduleStreamingContinuity', ['track', { kind: 'long-loop' }]],
  setLoop: ['setStreamingLoop', [true, 1, 2]],
  stop: ['stopStreamingPlayback', ['stopped', { preserveSnapshot: true }]],
  snapshot: ['getStreamingPlaybackSnapshot', []],
  fail: ['failStreamingEngine', ['socket', { message: 'x' }, 'reason']],
};

/** Both engines' implementations record their calls; [native] says Android negotiated native playback. */
function loadContract({ native = false, route = null, shell = false } = {}) {
  const calls = [];
  const record = name => (...args) => { calls.push([name, ...args]); return name; };
  const context = {
    isAndroidShell: () => shell,
    isAndroidNativePlayback: () => native,
    androidNativePlaybackRoute: () => route,
    connectAndroidBridge: record('connectAndroidBridge'),
    getAndroidNativePlaybackClientId: () => 'native-client',
    isAndroidNativePlaybackOwner: () => true,
  };
  for (const name of [
    'startBrowserStreamingTrack', 'pauseBrowserStreaming', 'resumeBrowserStreaming', 'seekBrowserStreaming',
    'scheduleBrowserStreamingContinuity', 'setBrowserStreamingLoop', 'stopBrowserStreaming',
    'getBrowserStreamingSnapshot', 'failBrowserStreaming',
    'startAndroidNativePlaybackTrack', 'pauseAndroidNativePlayback', 'resumeAndroidNativePlayback',
    'seekAndroidNativePlayback', 'scheduleAndroidNativeContinuity', 'setAndroidNativeLoop',
    'stopAndroidNativePlayback', 'getAndroidNativePlaybackSnapshot', 'failAndroidNativeEngine',
    'attachAndroidNativePlayback',
  ]) context[name] = record(name);
  vm.createContext(context);
  vm.runInContext(contractSource, context);
  return { context, calls };
}

test('outside native playback every player call reaches the browser engine with its arguments', () => {
  const { context, calls } = loadContract();
  for (const [facade, args] of Object.values(OPERATIONS)) context[facade](...args);
  assert.deepEqual(calls.map(([name]) => name), [
    'pauseBrowserStreaming', 'resumeBrowserStreaming', 'seekBrowserStreaming', 'scheduleBrowserStreamingContinuity',
    'setBrowserStreamingLoop', 'stopBrowserStreaming', 'getBrowserStreamingSnapshot', 'failBrowserStreaming',
  ]);
  assert.deepEqual(calls[1], ['resumeBrowserStreaming', 7, 'started', 'role']);
  assert.deepEqual(calls[4], ['setBrowserStreamingLoop', true, 1, 2]);
  const engine = context.currentPlaybackEngine();
  assert.equal(engine.holdsOwnClaim, false);
  assert.equal(engine.recordsListens, false);
  assert.equal(engine.claimClientId(), '');
  assert.equal(context.adoptEnginePlayback({}), null);
});

test('with native playback negotiated every player call reaches the Android engine', () => {
  const { context, calls } = loadContract({ native: true, shell: true });
  for (const [facade, args] of Object.values(OPERATIONS)) context[facade](...args);
  assert.deepEqual(calls.map(([name]) => name), [
    'pauseAndroidNativePlayback', 'resumeAndroidNativePlayback', 'seekAndroidNativePlayback',
    'scheduleAndroidNativeContinuity', 'setAndroidNativeLoop', 'stopAndroidNativePlayback',
    'getAndroidNativePlaybackSnapshot', 'failAndroidNativeEngine',
  ]);
  // Android resumes from its own buffer and loops by the range it was sent.
  assert.deepEqual(calls[1], ['resumeAndroidNativePlayback', 'started']);
  assert.deepEqual(calls[4], ['setAndroidNativeLoop', true]);
  const engine = context.currentPlaybackEngine();
  assert.equal(engine.holdsOwnClaim, true);
  assert.equal(engine.recordsListens, true);
  assert.equal(engine.claimClientId(), 'native-client');
  assert.equal(engine.ownsPlayback(), true);
  assert.equal(context.adoptEnginePlayback({ track: {} }), 'attachAndroidNativePlayback');
});

test('a start waits for the bridge only inside the APK, then runs on the negotiated engine', async () => {
  const browser = loadContract();
  const started = browser.context.startStreamingTrack('track', { startSeconds: 3 });
  // Outside the APK nothing waits: the browser start runs in the same turn.
  assert.deepEqual(browser.calls, [['startBrowserStreamingTrack', 'track', { startSeconds: 3 }]]);
  await started;
  assert.equal(browser.context.playbackEngineHandshake(), null);

  const native = loadContract({ shell: true, route: Promise.resolve(true) });
  await native.context.startStreamingTrack('track', { startSeconds: 3, autoplay: false, extra: 1 });
  // The options object is made inside the contract's context, so it is compared as data.
  assert.equal(JSON.stringify(native.calls), JSON.stringify([['startAndroidNativePlaybackTrack', 'track', { startSeconds: 3, autoplay: false }]]));
  assert.equal(native.context.playbackEngineHandshake(), 'connectAndroidBridge');

  const refused = loadContract({ shell: true, route: Promise.resolve(false) });
  await refused.context.startStreamingTrack('track');
  assert.equal(refused.calls[0][0], 'startBrowserStreamingTrack');
});

test('only the contract and the two engines know which platform plays', () => {
  const engines = new Set(['playback-engine.js', 'android-bridge-client.js', 'player-streaming-engine.js']);
  const platformCalls = /\b(isAndroidNativePlayback|isNativeStreamingPlayback|attachAndroidNativePlayback|getAndroidNativePlaybackClientId|isAndroidNativePlaybackOwner|androidNativePlaybackRoute)\s*\(/;
  const offenders = fs.readdirSync(runtimeDir)
    .filter(name => name.endsWith('.js') && !engines.has(name))
    .filter(name => platformCalls.test(fs.readFileSync(path.join(runtimeDir, name), 'utf8')));
  assert.deepEqual(offenders, []);
});
