// The player's one playback-engine contract. Two engines implement it: the browser's
// AudioWorklet engine (player-streaming-engine.js) and Android's native engine behind the shell
// bridge (android-bridge-client.js). Player code calls only the functions below; nothing else asks
// which platform it runs on.
//
// Each engine also answers two policy questions for the ownership and listen helpers:
// `holdsOwnClaim` (it acquires, renews and releases the server playback claim itself) and
// `recordsListens` (it sends every listen write itself).

const BROWSER_PLAYBACK_ENGINE = Object.freeze({
  id: 'browser',
  holdsOwnClaim: false,
  recordsListens: false,
  claimClientId: () => '',
  ownsPlayback: () => false,
  adopt: () => null,
  start: (track, options) => startBrowserStreamingTrack(track, options),
  pause: () => pauseBrowserStreaming(),
  resume: (expectedStartRequestId, onPlaybackStarted, expectedCurrentRole) =>
    resumeBrowserStreaming(expectedStartRequestId, onPlaybackStarted, expectedCurrentRole),
  seek: seconds => seekBrowserStreaming(seconds),
  continuity: (track, options) => scheduleBrowserStreamingContinuity(track, options),
  setLoop: (active, startSeconds, endSeconds) => setBrowserStreamingLoop(active, startSeconds, endSeconds),
  stop: (reason, options) => stopBrowserStreaming(reason, options),
  snapshot: () => getBrowserStreamingSnapshot(),
  fail: (source, event, reason) => failBrowserStreaming(source, event, reason),
});

const ANDROID_NATIVE_PLAYBACK_ENGINE = Object.freeze({
  id: 'android-native',
  holdsOwnClaim: true,
  recordsListens: true,
  claimClientId: () => getAndroidNativePlaybackClientId(),
  ownsPlayback: () => isAndroidNativePlaybackOwner(),
  adopt: persistedState => attachAndroidNativePlayback(persistedState),
  start: (track, { startSeconds = 0, autoplay = true } = {}) =>
    startAndroidNativePlaybackTrack(track, { startSeconds, autoplay }),
  pause: () => pauseAndroidNativePlayback(),
  resume: (_expectedStartRequestId, onPlaybackStarted) => resumeAndroidNativePlayback(onPlaybackStarted),
  seek: seconds => seekAndroidNativePlayback(seconds),
  continuity: (track, options) => scheduleAndroidNativeContinuity(track, options),
  setLoop: active => setAndroidNativeLoop(active),
  stop: (reason, options) => stopAndroidNativePlayback(reason, options),
  snapshot: () => getAndroidNativePlaybackSnapshot(),
  fail: (source, event, reason) => failAndroidNativeEngine(source, event, reason),
});

function isInsideAndroidShell() {
  return typeof isAndroidShell === 'function' && isAndroidShell();
}

// The engine playing now: Android's once its handshake negotiated native playback.
function currentPlaybackEngine() {
  return typeof isAndroidNativePlayback === 'function' && isAndroidNativePlayback()
    ? ANDROID_NATIVE_PLAYBACK_ENGINE : BROWSER_PLAYBACK_ENGINE;
}

// Inside the APK only the bridge handshake says which engine plays: the promise to wait for it, or
// null elsewhere, so a browser never waits a turn it did not need.
function playbackEngineHandshake() {
  return isInsideAndroidShell() ? connectAndroidBridge() : null;
}

// A reloaded document re-attaches to playback its engine kept going; null when there is none.
function adoptEnginePlayback(persistedState) {
  return isInsideAndroidShell() ? ANDROID_NATIVE_PLAYBACK_ENGINE.adopt(persistedState) : null;
}

// A new start decides its engine, waiting for the handshake only inside the APK.
async function startStreamingTrack(track, options = {}) {
  const nativeRoute = typeof androidNativePlaybackRoute === 'function' ? androidNativePlaybackRoute() : null;
  const engine = nativeRoute && await nativeRoute ? ANDROID_NATIVE_PLAYBACK_ENGINE : BROWSER_PLAYBACK_ENGINE;
  return engine.start(track, options);
}

function pauseStreamingPlayback() {
  return currentPlaybackEngine().pause();
}

function resumeStreamingPlayback(expectedStartRequestId = null, onPlaybackStarted = null, expectedCurrentRole = null) {
  return currentPlaybackEngine().resume(expectedStartRequestId, onPlaybackStarted, expectedCurrentRole);
}

function seekStreamingPlayback(seconds) {
  return currentPlaybackEngine().seek(seconds);
}

function scheduleStreamingContinuity(track, options = {}) {
  return currentPlaybackEngine().continuity(track, options);
}

function setStreamingLoop(active, startSeconds = 0, endSeconds = 0) {
  return currentPlaybackEngine().setLoop(active, startSeconds, endSeconds);
}

function stopStreamingPlayback(reason = 'stopped', options = {}) {
  return currentPlaybackEngine().stop(reason, options);
}

function getStreamingPlaybackSnapshot() {
  return currentPlaybackEngine().snapshot();
}

function failStreamingEngine(source, event, reason) {
  return currentPlaybackEngine().fail(source, event, reason);
}
