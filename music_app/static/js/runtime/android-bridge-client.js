// Web side of Android bridge v1. `AlbumHavenBridge` exists only inside the APK,
// injected by the shell for its exact allowed origins.
const ANDROID_BRIDGE_PROTOCOL = 1;
const ANDROID_BRIDGE_TIMEOUT_MS = 15000;

const androidBridge = { info: null, pending: new Map(), connection: null, events: new Map() };

function isAndroidShell() {
  return typeof window !== 'undefined' && Boolean(window.AlbumHavenBridge);
}

function hasAndroidCapability(capability) {
  return Boolean(androidBridge.info?.capabilities?.includes(capability));
}

// Fails closed: the APK stays silent until its shell negotiates an audio path,
// either native audio or the interim web player inside the WebView.
function isAndroidPlaybackUnavailable() {
  return isAndroidShell() && !hasAndroidCapability('playback.native.v1')
    && !hasAndroidCapability('playback.webview.v1');
}

function createAndroidBridgeMessageId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const hex = Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function handleAndroidBridgeMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (_error) {
    return;
  }
  if (message?.type === 'event') {
    const handler = androidBridge.events.get(message.name);
    if (handler && message.payload && typeof message.payload === 'object') handler(message.payload);
    return;
  }
  if (message?.type !== 'response') return;
  const pending = androidBridge.pending.get(message.id);
  if (!pending) return;
  androidBridge.pending.delete(message.id);
  clearTimeout(pending.timer);
  if (message.payload?.ok) {
    pending.resolve(message.payload);
  } else {
    pending.reject(Object.assign(new Error(message.payload?.error?.message || 'Android bridge request failed.'),
      { code: message.payload?.error?.code || 'unknown' }));
  }
}

function sendAndroidBridgeCommand(name, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = createAndroidBridgeMessageId();
    const timer = setTimeout(() => {
      androidBridge.pending.delete(id);
      reject(Object.assign(new Error('Android bridge timed out.'), { code: 'timeout' }));
    }, ANDROID_BRIDGE_TIMEOUT_MS);
    androidBridge.pending.set(id, { resolve, reject, timer });
    window.AlbumHavenBridge.postMessage(JSON.stringify({
      protocol: ANDROID_BRIDGE_PROTOCOL, id, type: 'command', name, payload,
    }));
  });
}

function connectAndroidBridge() {
  if (!isAndroidShell()) return Promise.resolve(null);
  if (!androidBridge.connection) {
    window.AlbumHavenBridge.onmessage = handleAndroidBridgeMessage;
    androidBridge.connection = sendAndroidBridgeCommand('bridge.handshake', {
      protocolMin: ANDROID_BRIDGE_PROTOCOL, protocolMax: ANDROID_BRIDGE_PROTOCOL,
    }).then((info) => {
      androidBridge.info = info;
      if (isAndroidNativePlayback()) registerAndroidNativePlaybackEvents();
      return info;
    }, () => null);
  }
  return androidBridge.connection;
}

// ---- Native playback (playback.native.v1) ----
// Inside an APK that negotiates native playback, the streaming facade routes every transport
// call here instead of starting AudioWorklet output. The web player keeps its queue, listen and
// UI logic; Android owns the audible clock, the PCM socket and the server playback claim. The web
// still builds every listen write, and Android sends it with the claim the WebView never sees.
const ANDROID_NATIVE_PLAYBACK_CAPABILITY = 'playback.native.v1';
const ANDROID_NATIVE_QUEUE_LIMIT = 100;
const ANDROID_NATIVE_TEXT_LIMIT = 512;
const ANDROID_NATIVE_MESSAGE_BUDGET_BYTES = 60 * 1024;
const ANDROID_NATIVE_LOOP_RATE = 48000;
const ANDROID_NATIVE_REFERENCE_CACHE_LIMIT = 512;
// A cached reference is reused only while it stays valid well past a long track.
const ANDROID_NATIVE_REFERENCE_REUSE_MARGIN_MS = 60 * 60 * 1000;
const ANDROID_NATIVE_LISTEN_EFFECTS = {
  '/playback/session/now-playing': 'now-playing',
  '/playback/session/scrobble': 'scrobble',
  '/playback/session/complete': 'complete',
};

const androidNativePlayback = {
  revision: 0,
  appliedRevision: 0,
  items: [],
  index: 0,
  generation: 0,
  streamId: 0,
  firstFrameNotified: false,
  referenceRetried: false,
  loopKind: null,
  mode: 'stopped',
  lastError: null,
  // `owned` follows Android's claim events; `ownerIntent` covers a start whose claim is pending.
  ownership: 'none',
  ownerIntent: false,
  refs: new Map(),
  measure: { key: '', role: null, rendered: 0, underruns: 0 },
  snapshot: { currentTime: 0, duration: 0, paused: true, ended: false, src: '', readyState: 0 },
};

function isAndroidNativePlayback() {
  return hasAndroidCapability(ANDROID_NATIVE_PLAYBACK_CAPABILITY);
}

// Null outside the APK, so ordinary browsers keep their synchronous start path unchanged.
function androidNativePlaybackRoute() {
  if (!isAndroidShell()) return null;
  return connectAndroidBridge().then(() => isAndroidNativePlayback());
}

// The native client owns the server claim; web ownership reads then report it as "here".
function getAndroidNativePlaybackClientId() {
  if (!isAndroidNativePlayback()) return '';
  const clientId = String(androidBridge.info?.playback?.clientId || '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clientId) ? clientId : '';
}

// The web's side-effect guard for native playback: Android owns, or is acquiring for, this start.
function isAndroidNativePlaybackOwner() {
  const native = androidNativePlayback;
  return isAndroidNativePlayback() && (native.ownership === 'owned' || native.ownerIntent);
}

// The listen session's writes, sent by Android with its claim; the answer keeps only top-level fields.
async function postAndroidNativeListenEffect(url, body) {
  const effect = ANDROID_NATIVE_LISTEN_EFFECTS[url];
  if (!effect) throw new Error('Playback sync failed');
  const result = await sendAndroidBridgeCommand('playback.listenEffect', { effect, body });
  const data = result?.data && typeof result.data === 'object' ? result.data : {};
  if (!(result.status >= 200 && result.status < 300) || !data.ok) throw new Error(data.error || 'Playback sync failed');
  return data;
}

// Pause, stop and end keep Android's claim until their listen writes drain, as the web keeps its own.
async function releaseAndroidNativePlaybackOwnership() {
  const native = androidNativePlayback;
  if (native.ownerIntent) return false;
  if (typeof drainPlaybackSessionRequests === 'function') {
    await drainPlaybackSessionRequests(getAndroidNativePlaybackClientId());
  }
  if (native.ownerIntent || !native.appliedRevision) return false;
  await sendAndroidBridgeCommand('playback.releaseOwnership').catch(() => {});
  return true;
}

function androidNativeText(value) {
  return String(value || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, ANDROID_NATIVE_TEXT_LIMIT);
}

// The tracks after `track`, continuing into the following albums exactly where the web's own queue
// continues (`resolveNextPlaybackContextQueue`), so Android plays album to album gaplessly.
function androidNativeQueueWindow(track) {
  let queue = state.player.playbackQueue;
  const tracks = Array.isArray(queue?.tracks) ? queue.tracks : [];
  const start = tracks.findIndex(item => String(item?.path || '') === String(track.path));
  const window = [track];
  if (start < 0) return window;
  window.push(...tracks.slice(start + 1).filter(item => item?.path));
  const albums = new Set([String(queue?.albumRef || '')]);
  while (window.length < ANDROID_NATIVE_QUEUE_LIMIT && typeof resolveNextPlaybackContextQueue === 'function') {
    queue = resolveNextPlaybackContextQueue(queue);
    if (!queue || albums.has(String(queue.albumRef || ''))) break;
    albums.add(String(queue.albumRef || ''));
    window.push(...(Array.isArray(queue.tracks) ? queue.tracks : []).filter(item => item?.path));
  }
  return window.slice(0, ANDROID_NATIVE_QUEUE_LIMIT);
}

function cachedAndroidNativePlaybackRef(path) {
  const cached = androidNativePlayback.refs.get(path);
  return cached && cached.expiresAtMs - Date.now() > ANDROID_NATIVE_REFERENCE_REUSE_MARGIN_MS ? cached.playbackRef : '';
}

// One bounded batch for the references not already held, immediately before the queue reaches
// Android; a partial batch never does.
async function requestAndroidNativePlaybackRefs(items) {
  const refs = items.map(item => cachedAndroidNativePlaybackRef(String(item.path)));
  const missing = items.map((item, index) => ({ index, path: String(item.path) })).filter(({ index }) => !refs[index]);
  if (!missing.length) return refs;
  const tracks = missing.map(({ path }) => ({ clientKey: createAndroidBridgeMessageId(), path }));
  const response = await fetch('/playback/refs', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 1, tracks }),
  });
  if (!response.ok) throw new Error('Playback references are unavailable.');
  const result = await response.json();
  if (result?.protocol !== 1 || !Array.isArray(result.tracks) || result.tracks.length !== tracks.length) {
    throw new Error('Playback references are unavailable.');
  }
  const issuedRefs = tracks.map((track, index) => {
    const issued = result.tracks[index];
    if (issued?.clientKey !== track.clientKey || typeof issued.playbackRef !== 'string' || !issued.playbackRef) {
      throw new Error('Playback references are unavailable.');
    }
    return issued.playbackRef;
  });
  const expiresAtMs = Date.parse(result.expiresAt);
  missing.forEach(({ index, path }, position) => {
    refs[index] = issuedRefs[position];
    if (!(expiresAtMs > Date.now())) return;
    const cache = androidNativePlayback.refs;
    cache.delete(path);
    cache.set(path, { playbackRef: issuedRefs[position], expiresAtMs });
    if (cache.size > ANDROID_NATIVE_REFERENCE_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  });
  return refs;
}

function buildAndroidNativeQueuePayload(revision, items, refs, startSeconds, autoplay) {
  const payload = {
    queueRevision: revision,
    items: items.map((item, index) => ({
      playbackRef: refs[index],
      title: androidNativeText(item.title),
      artist: androidNativeText(item.artist),
      album: androidNativeText(item.album),
      artworkUrl: null,
      durationMs: Math.max(0, Math.round((Number(item.durationSeconds) || 0) * 1000)),
    })),
    currentIndex: 0,
    positionMs: Math.max(0, Math.round((Number(startSeconds) || 0) * 1000)),
    loop: null,
    autoplay: Boolean(autoplay),
  };
  const encoder = new TextEncoder();
  while (payload.items.length > 1
      && encoder.encode(JSON.stringify(payload)).length > ANDROID_NATIVE_MESSAGE_BUDGET_BYTES) {
    payload.items.pop();
  }
  return payload;
}

function androidNativeCurrentRole() {
  const native = androidNativePlayback;
  return {
    track: native.items[native.index] || null,
    generation: native.generation,
    streamId: native.streamId,
    firstFrameNotified: native.firstFrameNotified,
  };
}

async function startAndroidNativePlaybackTrack(track, { startSeconds = 0, autoplay = true, referenceRetry = false } = {}) {
  const native = androidNativePlayback;
  const revision = ++native.revision;
  native.ownerIntent = Boolean(autoplay);
  const window = androidNativeQueueWindow(track);
  // A refused reference may be stale; the retry asks for fresh ones.
  if (referenceRetry) window.forEach(item => native.refs.delete(String(item.path)));
  const refs = await requestAndroidNativePlaybackRefs(window);
  if (revision !== native.revision) return null;
  const payload = buildAndroidNativeQueuePayload(revision, window, refs, startSeconds, autoplay);
  await sendAndroidBridgeCommand('playback.loadQueue', payload);
  if (revision !== native.revision) return null;
  native.appliedRevision = revision;
  native.items = window.slice(0, payload.items.length);
  native.index = 0;
  native.generation += 1;
  native.streamId += 1;
  native.firstFrameNotified = false;
  native.loopKind = null;
  native.lastError = null;
  if (!referenceRetry) native.referenceRetried = false;
  Object.assign(native.snapshot, {
    currentTime: Math.max(0, Number(startSeconds) || 0),
    duration: Number(track.durationSeconds) || 0,
    paused: !autoplay,
    ended: false,
    src: track.src || '',
    readyState: 0,
  });
  native.mode = autoplay ? 'starting' : 'paused';
  return androidNativeCurrentRole();
}

function sendAndroidNativeTransport(name, payload = {}) {
  if (!androidNativePlayback.appliedRevision) return Promise.resolve(false);
  return sendAndroidBridgeCommand(name, payload).then(() => true);
}

function pauseAndroidNativePlayback() {
  const native = androidNativePlayback;
  native.ownerIntent = false;
  native.snapshot.paused = true;
  if (native.mode !== 'error') native.mode = 'paused';
  return sendAndroidNativeTransport('playback.pause').then(() => undefined);
}

async function resumeAndroidNativePlayback(onPlaybackStarted = null) {
  const native = androidNativePlayback;
  if (!native.items.length) return false;
  if (native.snapshot.paused === false) return true;
  native.ownerIntent = true;
  const resumed = await sendAndroidNativeTransport('playback.play', { queueRevision: native.appliedRevision });
  if (!resumed) return false;
  native.snapshot.paused = false;
  native.snapshot.ended = false;
  native.mode = native.firstFrameNotified ? 'playing' : 'starting';
  if (typeof onPlaybackStarted === 'function') onPlaybackStarted();
  return true;
}

async function seekAndroidNativePlayback(seconds) {
  const native = androidNativePlayback;
  if (!native.items.length) return null;
  const startSeconds = Math.max(0, Number(seconds) || 0);
  native.snapshot.currentTime = startSeconds;
  native.snapshot.ended = false;
  await sendAndroidNativeTransport('playback.seek', {
    queueRevision: native.appliedRevision, positionMs: Math.round(startSeconds * 1000),
  });
  return androidNativeCurrentRole();
}

async function scheduleAndroidNativeContinuity(track, options = {}) {
  const native = androidNativePlayback;
  const current = native.items[native.index];
  if (!current) return null;
  const kind = options.kind || 'queued-next';
  if (kind === 'queued-next') {
    if (String(native.items[native.index + 1]?.path || '') === String(track?.path || '')) {
      return androidNativeCurrentRole();
    }
    // The queue changed under Android; reload it from the heard position unless that cannot help.
    if (String(androidNativeQueueWindow(current)[1]?.path || '') !== String(track?.path || '')) {
      return androidNativeCurrentRole();
    }
    return startAndroidNativePlaybackTrack(current, {
      startSeconds: native.snapshot.currentTime, autoplay: !native.snapshot.paused,
    });
  }
  const startFrame = Math.round(Math.max(0, Number(options.startSeconds) || 0) * ANDROID_NATIVE_LOOP_RATE);
  const endFrame = Math.round(Math.max(0, Number(options.endSeconds) || 0) * ANDROID_NATIVE_LOOP_RATE);
  if (endFrame <= startFrame) return null;
  native.loopKind = kind;
  await sendAndroidNativeTransport('playback.setLoop', {
    queueRevision: native.appliedRevision, startFrame, endFrame,
  });
  return androidNativeCurrentRole();
}

function setAndroidNativeLoop(active) {
  if (active) return true;
  androidNativePlayback.loopKind = null;
  void sendAndroidNativeTransport('playback.clearLoop', {
    queueRevision: androidNativePlayback.appliedRevision,
  }).catch(() => {});
  return true;
}

async function stopAndroidNativePlayback(_reason = 'stopped', { preserveSnapshot = false, preserveError = false } = {}) {
  const native = androidNativePlayback;
  const wasLoaded = native.appliedRevision > 0 && native.items.length > 0;
  native.revision += 1;
  native.ownerIntent = false;
  native.items = [];
  native.index = 0;
  native.loopKind = null;
  if (!preserveError) {
    native.mode = 'stopped';
    native.lastError = null;
  }
  Object.assign(native.snapshot, {
    currentTime: preserveSnapshot ? native.snapshot.currentTime : 0,
    duration: preserveSnapshot ? native.snapshot.duration : 0,
    paused: true,
    ended: false,
    src: preserveSnapshot ? native.snapshot.src : '',
    readyState: 0,
  });
  if (wasLoaded) await sendAndroidNativeTransport('playback.stop');
}

function failAndroidNativePlayback(source, message) {
  const native = androidNativePlayback;
  native.mode = 'error';
  native.lastError = { source, message: String(message || `${source} failed`) };
  native.snapshot.paused = true;
}

function getAndroidNativePlaybackSnapshot() {
  const native = androidNativePlayback;
  return {
    ...native.snapshot,
    mode: native.mode,
    generation: native.generation,
    diagnostics: {
      native: true,
      queueRevision: native.appliedRevision,
      currentIndex: native.index,
      ...(native.lastError ? { lastError: { ...native.lastError } } : {}),
      bufferedFrames: { current: 0, continuity: 0 },
      inFlightFrames: { current: 0, continuity: 0 },
      activeRoles: [],
    },
  };
}

function androidNativeMeasure() {
  const native = androidNativePlayback;
  const key = `${native.generation}:${native.index}`;
  if (native.measure.key !== key) {
    native.measure = { key, role: { role: 'current', track: native.items[native.index] || null }, rendered: 0, underruns: 0 };
  }
  return native.measure;
}

// Android reports the frames of the current item it actually played; the web listen session
// counts them exactly as it counts AudioWorklet output (`rendered-pcm-v1`).
function recordAndroidNativeListening(payload) {
  const measure = androidNativeMeasure();
  const rendered = Number(payload.renderedFrames);
  const sampleRate = Number(payload.sampleRate);
  if (Number.isInteger(rendered) && rendered > measure.rendered && sampleRate > 0 && measure.role.track
      && typeof recordMeasuredStreamingFrames === 'function') {
    recordMeasuredStreamingFrames(measure.role, { frames: rendered - measure.rendered }, sampleRate);
    // Frames the session could not take yet are counted once it exists.
    if (measure.role.measuredListenSession) measure.rendered = rendered;
  }
  const underruns = Number(payload.underruns);
  if (Number.isInteger(underruns) && underruns > measure.underruns) {
    measure.underruns = underruns;
    if (typeof breakMeasuredListenSegment === 'function') breakMeasuredListenSegment(measure.role.measuredListenSession);
  }
}

function observeAndroidNativeFacade(result, source) {
  if (typeof observeStreamingFacadeCallback === 'function') observeStreamingFacadeCallback(result, source);
}

function notifyAndroidNativeWaveformReady() {
  const native = androidNativePlayback;
  if (typeof handleStreamingPlaybackWaveformReady !== 'function') return;
  void Promise.resolve(handleStreamingPlaybackWaveformReady({
    generation: native.generation,
    currentPath: String(native.items[native.index]?.path || ''),
    continuityPath: String(native.items[native.index + 1]?.path || ''),
  })).catch(error => console.warn('[AlbumHaven][Waveform] Optional peak load failed.', error));
}

function handleAndroidNativeState(payload) {
  const native = androidNativePlayback;
  const snapshot = native.snapshot;
  const trackPath = String(native.items[native.index]?.path || '');
  const nativeState = payload.state;
  snapshot.currentTime = Math.max(0, Number(payload.positionMs) || 0) / 1000;
  recordAndroidNativeListening(payload);
  // Android plays only while it holds the claim.
  if (nativeState === 'playing') native.ownership = 'owned';
  else if (nativeState !== 'buffering' && nativeState !== 'loading') native.ownerIntent = false;
  if (nativeState === 'playing' || nativeState === 'buffering' || nativeState === 'loading') {
    Object.assign(snapshot, { paused: false, ended: false });
    native.mode = nativeState === 'playing' ? 'playing' : nativeState === 'loading' ? 'starting' : 'buffering';
    if (nativeState === 'playing') snapshot.readyState = 4;
    if (nativeState === 'playing' && !native.firstFrameNotified && trackPath) {
      native.firstFrameNotified = true;
      if (typeof handleStreamingPlaybackFirstFrame === 'function') {
        observeAndroidNativeFacade(handleStreamingPlaybackFirstFrame({
          generation: native.generation, streamId: native.streamId, trackPath,
        }), 'first-frame-facade-error');
      }
      notifyAndroidNativeWaveformReady();
    }
  } else if (nativeState === 'ended') {
    Object.assign(snapshot, { paused: true, ended: true, readyState: 4 });
    native.mode = 'ended';
    const queuedBeyondWindow = native.index === native.items.length - 1 && typeof peekNextQueuedTrack === 'function'
      ? String(peekNextQueuedTrack()?.path || '') : '';
    if (typeof handleStreamingPlaybackEnded === 'function' && trackPath) {
      observeAndroidNativeFacade(handleStreamingPlaybackEnded({
        generation: native.generation, streamId: native.streamId, trackPath,
        timelineFrame: 0, currentTime: snapshot.currentTime,
        // Reuses the web engine's continue-on-a-new-start path for a queue longer than the window.
        sampleRateChangeTrackPath: queuedBeyondWindow,
      }), 'ended-facade-error');
    }
  } else {
    snapshot.paused = true;
    if (nativeState === 'error') native.mode = 'error';
    else if (native.mode !== 'error') native.mode = nativeState === 'idle' ? 'stopped' : 'paused';
  }
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
}

function handleAndroidNativePosition(payload) {
  const native = androidNativePlayback;
  const trackPath = String(native.items[native.index]?.path || '');
  native.snapshot.currentTime = Math.max(0, Number(payload.positionMs) || 0) / 1000;
  recordAndroidNativeListening(payload);
  if (typeof handleStreamingPlaybackPosition === 'function' && trackPath) {
    observeAndroidNativeFacade(handleStreamingPlaybackPosition({
      generation: native.generation, streamId: native.streamId, trackPath,
      timelineFrame: 0, currentTime: native.snapshot.currentTime,
    }), 'position-facade-error');
  } else if (typeof updatePlayerUi === 'function') {
    updatePlayerUi();
  }
}

function handleAndroidNativeCurrentItem(payload) {
  const native = androidNativePlayback;
  // Load, next and previous name items the web already selected; only a natural advance is new.
  if (payload.reason !== 'advance' || payload.currentIndex !== native.index + 1) return;
  const outgoing = native.items[native.index];
  const incoming = native.items[payload.currentIndex];
  if (!outgoing || !incoming) return;
  // The outgoing listen is complete before the boundary finalizes it.
  recordAndroidNativeListening({ sampleRate: payload.sampleRate, renderedFrames: payload.outgoingRenderedFrames });
  const outgoingPlaybackSnapshot = {
    ...native.snapshot,
    currentTime: Number(outgoing.durationSeconds) || native.snapshot.currentTime,
    duration: Number(outgoing.durationSeconds) || 0,
    src: outgoing.src || '',
  };
  const outgoingStreamId = native.streamId;
  native.index = payload.currentIndex;
  native.streamId += 1;
  Object.assign(native.snapshot, {
    currentTime: Math.max(0, Number(payload.positionMs) || 0) / 1000,
    duration: Number(incoming.durationSeconds) || 0,
    src: incoming.src || '',
    ended: false,
  });
  if (typeof handleStreamingPlaybackBoundary === 'function') {
    observeAndroidNativeFacade(handleStreamingPlaybackBoundary({
      generation: native.generation,
      outgoingStreamId,
      incomingStreamId: native.streamId,
      outgoingTrackPath: String(outgoing.path || ''),
      incomingTrackPath: String(incoming.path || ''),
      outgoingPlaybackSnapshot,
      incomingListenSession: null,
      renderedFrame: 0,
      continuityKind: 'queued-next',
    }), 'boundary-facade-error');
  }
  recordAndroidNativeListening(payload);
  notifyAndroidNativeWaveformReady();
}

function handleAndroidNativeLoopWrapped() {
  const native = androidNativePlayback;
  const trackPath = String(native.items[native.index]?.path || '');
  if (!native.loopKind || !trackPath || typeof handleStreamingPlaybackBoundary !== 'function') return;
  const outgoingStreamId = native.streamId;
  native.streamId += 1;
  observeAndroidNativeFacade(handleStreamingPlaybackBoundary({
    generation: native.generation, outgoingStreamId, incomingStreamId: native.streamId,
    outgoingTrackPath: trackPath, incomingTrackPath: trackPath, renderedFrame: 0,
    continuityKind: native.loopKind,
  }), 'boundary-facade-error');
}

function handleAndroidNativeOwnership(payload) {
  const native = androidNativePlayback;
  native.ownership = payload.ownership === 'owned' ? 'owned' : 'none';
  if (payload.ownership === 'owned') {
    if (typeof clearBlockedPlaybackState === 'function') clearBlockedPlaybackState();
    return;
  }
  if (payload.ownership !== 'blocked' && payload.ownership !== 'lost') return;
  native.ownerIntent = false;
  // Another client holds the claim: the same blocked path as the web player's refused claim.
  if (typeof losePlaybackOwnership === 'function') losePlaybackOwnership('ownership-takeover');
  if (typeof handlePlaybackOwnershipEvent === 'function') void handlePlaybackOwnershipEvent();
  if (payload.ownership === 'blocked' && typeof notifyBlockedPlaybackStart === 'function') {
    notifyBlockedPlaybackStart();
  }
}

function handleAndroidNativeError(payload) {
  failAndroidNativePlayback('native', payload.error?.message);
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
}

function handleAndroidNativeReferenceExpired() {
  const native = androidNativePlayback;
  const track = native.items[native.index];
  if (!track || native.referenceRetried) {
    failAndroidNativePlayback('reference', 'Playback reference expired.');
    if (typeof updatePlayerUi === 'function') updatePlayerUi();
    return;
  }
  // References last a day; one fresh batch recovers a long session at the heard position.
  native.referenceRetried = true;
  observeAndroidNativeFacade(startAndroidNativePlaybackTrack(track, {
    startSeconds: native.snapshot.currentTime, autoplay: true, referenceRetry: true,
  }), 'reference-refresh-error');
}

function registerAndroidNativePlaybackEvents() {
  const handlers = {
    'playback.state': handleAndroidNativeState,
    'playback.position': handleAndroidNativePosition,
    'playback.currentItem': handleAndroidNativeCurrentItem,
    'playback.loopWrapped': handleAndroidNativeLoopWrapped,
    'playback.ownership': handleAndroidNativeOwnership,
    'playback.error': handleAndroidNativeError,
    'playback.referenceExpired': handleAndroidNativeReferenceExpired,
  };
  for (const [name, handler] of Object.entries(handlers)) {
    androidBridge.events.set(name, (payload) => {
      // Events echo the applied revision so a replaced queue cannot overwrite newer state.
      if (payload.queueRevision !== androidNativePlayback.appliedRevision) return;
      handler(payload);
    });
  }
}
