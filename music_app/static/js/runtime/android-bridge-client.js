// Web side of Android bridge v1. `AlbumHavenBridge` exists only inside the APK,
// injected by the shell for its exact allowed origins.
//
// The bridge policy. `protocolMin`-`protocolMax` keeps the latest and the immediately previous
// stable shell protocol (tests/fixtures/android-bridge/stable-shells.json). `capabilities` names
// every shell capability this site reads. `optional`: without it the feature hides or fails closed.
// `required`: the site cannot run without it, so the shell refuses the handshake and shows its
// Update required screen. scripts/ci/android-release-compatibility.cjs reads the JSON between the
// two markers as data, without running this file, to order web releases after the APKs they need.
const ANDROID_BRIDGE_POLICY = /* android-bridge-policy */ {
  "protocolMin": 1,
  "protocolMax": 1,
  "capabilities": {
    "playback.native.v1": "optional",
    "playback.webview.v1": "optional",
    "playback.queue.v1": "optional",
    "playback.loops.v1": "optional",
    "playback.media_session.v1": "optional",
    "playback.resumption.v1": "optional",
    "sandbox.select.v1": "optional",
    "updates.manual.v1": "optional"
  }
} /* end android-bridge-policy */;
const ANDROID_BRIDGE_PROTOCOL_MIN = ANDROID_BRIDGE_POLICY.protocolMin;
const ANDROID_BRIDGE_PROTOCOL_MAX = ANDROID_BRIDGE_POLICY.protocolMax;
const ANDROID_BRIDGE_CAPABILITY_USE = Object.freeze({ ...ANDROID_BRIDGE_POLICY.capabilities });
const ANDROID_BRIDGE_TIMEOUT_MS = 15000;
const ANDROID_REQUIRED_CAPABILITIES = Object.keys(ANDROID_BRIDGE_CAPABILITY_USE)
  .filter(capability => ANDROID_BRIDGE_CAPABILITY_USE[capability] === 'required').sort();

// `updateRequired` is set when the shell cannot run this site: no shared protocol or a missing
// required capability. Every bridge feature then stays off, as it does with no shell at all.
const androidBridge = { info: null, pending: new Map(), connection: null, events: new Map(), updateRequired: false };

// The shell injects a plain script object with `postMessage`. Named access can expose an element or
// a frame's window under the same global name; neither is the shell (capability-ui.js agrees).
function isAndroidShell() {
  const bridge = typeof window !== 'undefined' ? window.AlbumHavenBridge : null;
  return typeof bridge?.postMessage === 'function' && bridge.window !== bridge;
}

function hasAndroidCapability(capability) {
  return Boolean(androidBridge.info?.capabilities?.includes(capability));
}

function isAndroidUpdateRequired() {
  return androidBridge.updateRequired;
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
    // Commands use the negotiated protocol; the handshake offers the newest this site speaks.
    window.AlbumHavenBridge.postMessage(JSON.stringify({
      protocol: androidBridge.info?.bridgeProtocol || ANDROID_BRIDGE_PROTOCOL_MAX, id, type: 'command', name, payload,
    }));
  });
}

// A shell that negotiated outside this site's range, or lacks a required capability, cannot run it.
// Current shells refuse such a handshake themselves; this also covers one that did not.
function canAndroidShellRunSite(info) {
  const protocol = info?.bridgeProtocol;
  return Number.isInteger(protocol) && protocol >= ANDROID_BRIDGE_PROTOCOL_MIN && protocol <= ANDROID_BRIDGE_PROTOCOL_MAX
    && Array.isArray(info.capabilities) && ANDROID_REQUIRED_CAPABILITIES.every(name => info.capabilities.includes(name));
}

function connectAndroidBridge() {
  if (!isAndroidShell()) return Promise.resolve(null);
  if (!androidBridge.connection) {
    window.AlbumHavenBridge.onmessage = handleAndroidBridgeMessage;
    androidBridge.connection = sendAndroidBridgeCommand('bridge.handshake', {
      protocolMin: ANDROID_BRIDGE_PROTOCOL_MIN, protocolMax: ANDROID_BRIDGE_PROTOCOL_MAX,
      requiredCapabilities: ANDROID_REQUIRED_CAPABILITIES,
    }).then((info) => {
      if (!canAndroidShellRunSite(info)) {
        androidBridge.updateRequired = true;
        return null;
      }
      androidBridge.info = info;
      if (isAndroidNativePlayback()) registerAndroidNativePlaybackEvents();
      return info;
    }, (error) => {
      androidBridge.updateRequired = error.code === 'incompatible_bridge' || error.code === 'update_required';
      // A shell that refused this site stays refused; a timeout or other failure is asked again.
      if (!androidBridge.updateRequired) androidBridge.connection = null;
      return null;
    });
  }
  return androidBridge.connection;
}

// ---- Native playback (playback.native.v1) ----
// Inside an APK that negotiates native playback, the streaming facade routes every transport
// call here instead of starting AudioWorklet output. The web player keeps its queue and UI logic;
// Android owns the audible clock, the PCM socket, the server playback claim and every listen write
// (now-playing, scrobble, completion), so listening is recorded with or without this document.
const ANDROID_NATIVE_PLAYBACK_CAPABILITY = 'playback.native.v1';
// Album queue groups and a queue replaced around the playing item (`keepCurrent`).
const ANDROID_NATIVE_QUEUE_CAPABILITY = 'playback.queue.v1';
// `playback.setLoop` with the web's loop kind, and `playback.clearLoop`.
const ANDROID_NATIVE_LOOPS_CAPABILITY = 'playback.loops.v1';
const ANDROID_NATIVE_QUEUE_LIMIT = 100;
const ANDROID_NATIVE_TEXT_LIMIT = 512;
const ANDROID_NATIVE_MESSAGE_BUDGET_BYTES = 60 * 1024;
const ANDROID_NATIVE_LOOP_RATE = 48000;
const ANDROID_NATIVE_REFERENCE_CACHE_LIMIT = 512;
// A cached reference is reused only while it stays valid well past a long track.
const ANDROID_NATIVE_REFERENCE_REUSE_MARGIN_MS = 60 * 60 * 1000;
// The shell keeps playback in a media session that outlives the document (playback.media_session.v1).
const ANDROID_NATIVE_MEDIA_SESSION_CAPABILITY = 'playback.media_session.v1';
const ANDROID_NATIVE_ATTACHMENT_STORAGE_KEY = 'albumhaven.androidNativeQueue.v1';
// The shell persists each item's path-free resume token, so its media card can resume playback
// after the session, the process or the device restarted (playback.resumption.v1).
const ANDROID_NATIVE_RESUMPTION_CAPABILITY = 'playback.resumption.v1';
const ANDROID_NATIVE_RESUME_TOKEN = /^[A-Za-z0-9_.-]{1,512}$/;
const ANDROID_NATIVE_ATTACHABLE_STATES = new Set(['loading', 'buffering', 'playing', 'paused']);

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

function androidNativeText(value) {
  return String(value || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, ANDROID_NATIVE_TEXT_LIMIT);
}

// The album queue `track` plays in, from its first track so Android's previous reaches what the
// web's previous does (`playCompactQueueOffset`), then the albums the web's own queue continues
// into (`resolveNextPlaybackContextQueue`), so Android plays album to album gaplessly. Each album is
// one `queueGroup`: Android's previous and next stay inside it, as the web's do.
function androidNativeQueueWindow(track) {
  let queue = state.player.playbackQueue;
  const tracks = (Array.isArray(queue?.tracks) ? queue.tracks : []).filter(item => item?.path);
  const start = tracks.findIndex(item => String(item.path) === String(track.path));
  if (start < 0) return { items: [track], groups: [0], currentIndex: 0 };
  const following = tracks.slice(start + 1, start + ANDROID_NATIVE_QUEUE_LIMIT);
  // Following tracks keep their place first; earlier ones fill what the limit leaves.
  const earlier = tracks.slice(Math.max(0, start - (ANDROID_NATIVE_QUEUE_LIMIT - 1 - following.length)), start);
  const items = [...earlier, track, ...following];
  const groups = items.map(() => 0);
  const albums = new Set([String(queue?.albumRef || '')]);
  while (items.length < ANDROID_NATIVE_QUEUE_LIMIT && typeof resolveNextPlaybackContextQueue === 'function') {
    queue = resolveNextPlaybackContextQueue(queue);
    if (!queue || albums.has(String(queue.albumRef || ''))) break;
    albums.add(String(queue.albumRef || ''));
    const next = (Array.isArray(queue.tracks) ? queue.tracks : []).filter(item => item?.path)
      .slice(0, ANDROID_NATIVE_QUEUE_LIMIT - items.length);
    items.push(...next);
    groups.push(...next.map(() => albums.size - 1));
  }
  return { items, groups, currentIndex: earlier.length };
}

function cachedAndroidNativePlaybackRef(path) {
  const cached = androidNativePlayback.refs.get(path);
  return cached && cached.expiresAtMs - Date.now() > ANDROID_NATIVE_REFERENCE_REUSE_MARGIN_MS ? cached : null;
}

// One bounded batch for the references not already held, immediately before the queue reaches
// Android; a partial batch never does. Each entry is `{ playbackRef, resumeToken }`; the resume
// token is null when the server issued none.
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
    const resumeToken = typeof issued.resumeToken === 'string' && ANDROID_NATIVE_RESUME_TOKEN.test(issued.resumeToken)
      ? issued.resumeToken : null;
    return { playbackRef: issued.playbackRef, resumeToken };
  });
  const expiresAtMs = Date.parse(result.expiresAt);
  missing.forEach(({ index, path }, position) => {
    refs[index] = issuedRefs[position];
    if (!(expiresAtMs > Date.now())) return;
    const cache = androidNativePlayback.refs;
    cache.delete(path);
    cache.set(path, { ...issuedRefs[position], expiresAtMs });
    if (cache.size > ANDROID_NATIVE_REFERENCE_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  });
  return refs;
}

// The web's own track identity (`getTrackIdentity`, which decides "same track" for a listen),
// hashed to 64 opaque bits, so Android tells a refreshed reference from another track without a path.
function androidNativeListenKey(item) {
  const identity = getTrackIdentity(item);
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let index = 0; index < identity.length; index += 1) {
    const code = identity.charCodeAt(index);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  return `lk1-${[high, low].map(half => (half >>> 0).toString(16).padStart(8, '0')).join('')}`;
}

// The window shrinks to the message budget from its front, then from its end, never past `currentIndex`.
function buildAndroidNativeQueuePayload(revision, queueWindow, refs, startSeconds, autoplay, keepCurrent = false) {
  const resumable = hasAndroidCapability(ANDROID_NATIVE_RESUMPTION_CAPABILITY);
  const grouped = hasAndroidCapability(ANDROID_NATIVE_QUEUE_CAPABILITY);
  const payload = {
    queueRevision: revision,
    items: queueWindow.items.map((item, index) => ({
      playbackRef: refs[index].playbackRef,
      listenKey: androidNativeListenKey(item),
      title: androidNativeText(item.title),
      artist: androidNativeText(item.artist),
      album: androidNativeText(item.album),
      // The track's cover, path-free, as the server resolves it for the resume token's track.
      artworkUrl: refs[index].resumeToken ? `/playback/artwork/${refs[index].resumeToken}` : null,
      durationMs: Math.max(0, Math.round((Number(item.durationSeconds) || 0) * 1000)),
      trackNumber: androidNativeText(item.trackNumber),
      ...(grouped ? { queueGroup: queueWindow.groups[index] } : {}),
      ...(resumable && refs[index].resumeToken ? { resumeToken: refs[index].resumeToken } : {}),
    })),
    currentIndex: queueWindow.currentIndex,
    positionMs: Math.max(0, Math.round((Number(startSeconds) || 0) * 1000)),
    loop: null,
    autoplay: Boolean(autoplay),
    // The current item is the one Android already plays; only the queue around it changes.
    ...(keepCurrent ? { keepCurrent: true } : {}),
  };
  const encoder = new TextEncoder();
  let first = 0;
  while (payload.items.length > 1
      && encoder.encode(JSON.stringify(payload)).length > ANDROID_NATIVE_MESSAGE_BUDGET_BYTES) {
    if (payload.currentIndex > 0) {
      payload.items.shift();
      payload.currentIndex -= 1;
      first += 1;
    } else {
      payload.items.pop();
    }
  }
  return { payload, first };
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

async function startAndroidNativePlaybackTrack(track, {
  startSeconds = 0, autoplay = true, referenceRetry = false, keepCurrent = false,
} = {}) {
  const native = androidNativePlayback;
  const revision = ++native.revision;
  native.ownerIntent = Boolean(autoplay);
  const queueWindow = androidNativeQueueWindow(track);
  // A refused reference may be stale; the retry asks for fresh ones.
  if (referenceRetry) queueWindow.items.forEach(item => native.refs.delete(String(item.path)));
  let payload;
  let first;
  try {
    const refs = await requestAndroidNativePlaybackRefs(queueWindow.items);
    if (revision !== native.revision) return null;
    ({ payload, first } = buildAndroidNativeQueuePayload(revision, queueWindow, refs, startSeconds, autoplay, keepCurrent));
    await sendAndroidBridgeCommand('playback.loadQueue', payload);
  } catch (error) {
    // Nothing Android plays came from this start, so it acquires nothing for it.
    if (revision === native.revision) native.ownerIntent = false;
    throw error;
  }
  if (revision !== native.revision) return null;
  native.appliedRevision = revision;
  native.items = queueWindow.items.slice(first, first + payload.items.length);
  saveAndroidNativeAttachment(revision, native.items);
  native.index = payload.currentIndex;
  // Android keeps playing the same item, so its first frame and listen are not new.
  if (keepCurrent) return androidNativeCurrentRole();
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

function androidNativeStoredTrack(track) {
  return {
    src: String(track.src || ''),
    path: String(track.path || ''),
    title: String(track.title || ''),
    artist: String(track.artist || ''),
    ...(track.albumArtist ? { albumArtist: String(track.albumArtist) } : {}),
    album: String(track.album || ''),
    coverPath: String(track.coverPath || ''),
    ...(track.trackNumber ? { trackNumber: String(track.trackNumber) } : {}),
    ...(Number(track.durationSeconds) > 0 ? { durationSeconds: Number(track.durationSeconds) } : {}),
  };
}

// The queue this document handed Android, kept beside the persisted player state so the next
// document of this origin can name the tracks Android is still playing.
function saveAndroidNativeAttachment(revision, items) {
  if (!hasAndroidCapability(ANDROID_NATIVE_MEDIA_SESSION_CAPABILITY) || typeof setLocalStorageItem !== 'function') return;
  setLocalStorageItem(ANDROID_NATIVE_ATTACHMENT_STORAGE_KEY, JSON.stringify({
    clientId: getAndroidNativePlaybackClientId(),
    queueRevision: revision,
    tracks: items.map(androidNativeStoredTrack),
  }));
}

// Only the exact native client and revision that queue was applied as can be adopted.
function readAndroidNativeAttachment(live) {
  if (typeof getLocalStorageItem !== 'function') return null;
  let record = null;
  try {
    record = JSON.parse(getLocalStorageItem(ANDROID_NATIVE_ATTACHMENT_STORAGE_KEY) || 'null');
  } catch (_error) {
    return null;
  }
  const tracks = Array.isArray(record?.tracks) ? record.tracks : [];
  if (!live.clientId || record?.clientId !== live.clientId || record.queueRevision !== live.queueRevision) return null;
  if (!Number.isInteger(live.currentIndex) || !tracks[live.currentIndex]
      || !tracks.every(track => track?.path && track.src)) return null;
  return tracks;
}

// Null outside the APK, so ordinary browsers restore exactly as before.
function attachAndroidNativePlayback(persistedState = null) {
  if (!isAndroidShell()) return null;
  return connectAndroidBridge().then(() => adoptAndroidNativePlayback(persistedState));
}

// A reloaded document of the same origin takes over the queue Android kept playing instead of
// restarting it: the same tracks, item, position and revision. Android's listen continues.
function adoptAndroidNativePlayback(persistedState) {
  const native = androidNativePlayback;
  const live = androidBridge.info?.playback;
  if (!hasAndroidCapability(ANDROID_NATIVE_MEDIA_SESSION_CAPABILITY) || native.revision !== 0
      || !ANDROID_NATIVE_ATTACHABLE_STATES.has(live?.state)) return false;
  const tracks = readAndroidNativeAttachment(live);
  if (!tracks) return false;
  const track = tracks[live.currentIndex];
  const playing = live.state !== 'paused';
  native.revision = live.queueRevision;
  native.appliedRevision = live.queueRevision;
  native.items = tracks;
  native.index = live.currentIndex;
  native.generation += 1;
  native.streamId += 1;
  native.firstFrameNotified = live.state === 'playing';
  native.referenceRetried = false;
  native.loopKind = null;
  native.lastError = null;
  native.ownerIntent = playing;
  if (live.state === 'playing') native.ownership = 'owned';
  native.mode = { playing: 'playing', paused: 'paused', loading: 'starting', buffering: 'buffering' }[live.state];
  Object.assign(native.snapshot, {
    currentTime: Math.max(0, Number(live.positionMs) || 0) / 1000,
    duration: Number(track.durationSeconds) || Math.max(0, Number(live.durationMs) || 0) / 1000,
    paused: !playing,
    ended: false,
    src: track.src,
    readyState: live.state === 'playing' ? 4 : 0,
  });
  state.player.playbackQueue = null;
  const restoredQueue = persistedState && typeof restorePersistedPlaybackQueue === 'function'
    && restorePersistedPlaybackQueue(persistedState, track.path);
  if (!restoredQueue && typeof resolveAlbumForPlayerTrack === 'function' && typeof setAlbumPlaybackQueue === 'function') {
    const album = resolveAlbumForPlayerTrack(track);
    if (album) setAlbumPlaybackQueue(album, track.path);
  }
  if (typeof setCurrentPlayerTrack === 'function') setCurrentPlayerTrack(track, { persist: false });
  // A reload restores loops inactive, so Android's loop ends with the old document.
  clearAndroidNativeLoop();
  notifyAndroidNativeWaveformReady();
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
  if (typeof persistPlayerState === 'function') persistPlayerState(true);
  return true;
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
  let resumed = false;
  try {
    resumed = await sendAndroidNativeTransport('playback.play', { queueRevision: native.appliedRevision });
  } finally {
    // A refused play acquires nothing.
    if (!resumed) native.ownerIntent = false;
  }
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
    // The queue changed under Android; replace the queue around the playing item unless that cannot
    // help. A shell without queue replacement keeps its own queue.
    const queueWindow = androidNativeQueueWindow(current);
    if (!hasAndroidCapability(ANDROID_NATIVE_QUEUE_CAPABILITY)
        || String(queueWindow.items[queueWindow.currentIndex + 1]?.path || '') !== String(track?.path || '')) {
      return androidNativeCurrentRole();
    }
    return startAndroidNativePlaybackTrack(current, {
      startSeconds: native.snapshot.currentTime, autoplay: !native.snapshot.paused, keepCurrent: true,
    });
  }
  // Without native loops the loop stays off, as when the web cannot schedule one.
  if (!hasAndroidCapability(ANDROID_NATIVE_LOOPS_CAPABILITY)) return null;
  const startFrame = Math.round(Math.max(0, Number(options.startSeconds) || 0) * ANDROID_NATIVE_LOOP_RATE);
  const endFrame = Math.round(Math.max(0, Number(options.endSeconds) || 0) * ANDROID_NATIVE_LOOP_RATE);
  if (endFrame <= startFrame) return null;
  native.loopKind = kind;
  // The web's kind decides retained replay exactly, as its worklet's `set-loop` does.
  await sendAndroidNativeTransport('playback.setLoop', {
    queueRevision: native.appliedRevision, startFrame, endFrame, kind,
  });
  return androidNativeCurrentRole();
}

function clearAndroidNativeLoop() {
  androidNativePlayback.loopKind = null;
  if (!hasAndroidCapability(ANDROID_NATIVE_LOOPS_CAPABILITY)) return;
  void sendAndroidNativeTransport('playback.clearLoop', {
    queueRevision: androidNativePlayback.appliedRevision,
  }).catch(() => {});
}

function setAndroidNativeLoop(active) {
  if (!active) clearAndroidNativeLoop();
  return true;
}

async function stopAndroidNativePlayback(reason = 'stopped', { preserveSnapshot = false, preserveError = false } = {}) {
  const native = androidNativePlayback;
  // A media session outlives the document: the next document of this origin re-attaches to it.
  if (reason === 'unload' && hasAndroidCapability(ANDROID_NATIVE_MEDIA_SESSION_CAPABILITY)) return;
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
  const stopped = wasLoaded ? sendAndroidNativeTransport('playback.stop') : null;
  // Android releases its claim with the stop; no event of the stopped queue applies any more.
  native.appliedRevision = 0;
  native.ownership = 'none';
  await stopped;
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

// Android's notification, lock screen, media buttons, Bluetooth and audio focus act on the native
// queue directly. The web then runs its own pause or resume path so its UI follows as after an
// on-page tap; Android has already applied the change and its listen writes.
function followAndroidNativeSystemState(payload) {
  const snapshot = androidNativePlayback.snapshot;
  const active = payload.state === 'playing' || payload.state === 'buffering' || payload.state === 'loading';
  if (payload.state === 'paused' && !snapshot.paused && typeof pausePlayerPlaybackForHandoff === 'function') {
    snapshot.currentTime = Math.max(0, Number(payload.positionMs) || 0) / 1000;
    void pausePlayerPlaybackForHandoff(getAndroidNativePlaybackSnapshot());
  } else if (active && snapshot.paused && typeof togglePlayerPlayback === 'function') {
    togglePlayerPlayback({ focusTimelineOnResume: false });
  }
}

// A skip from Android's controls: the web selects the item Android moved to as its own skip
// buttons would.
function followAndroidNativeSystemStep(payload) {
  const native = androidNativePlayback;
  const incoming = native.items[payload.currentIndex];
  if (!incoming || payload.currentIndex === native.index) return;
  const previousPlaybackSnapshot = getAndroidNativePlaybackSnapshot();
  native.index = payload.currentIndex;
  native.streamId += 1;
  native.firstFrameNotified = false;
  Object.assign(native.snapshot, {
    currentTime: Math.max(0, Number(payload.positionMs) || 0) / 1000,
    duration: Number(incoming.durationSeconds) || 0,
    src: incoming.src || '',
    ended: false,
  });
  const queue = state.player.playbackQueue;
  if (payload.reason === 'next' && typeof peekNextQueuedTrack === 'function'
      && String(peekNextQueuedTrack()?.path || '') === String(incoming.path)) {
    getNextQueuedTrack();
  } else if (Array.isArray(queue?.tracks)) {
    const found = queue.tracks.findIndex(track => String(track?.path || '') === String(incoming.path));
    if (found >= 0) queue.currentIndex = found;
  }
  if (typeof setCurrentPlayerTrack === 'function') setCurrentPlayerTrack(incoming, { previousPlaybackSnapshot });
  notifyAndroidNativeWaveformReady();
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
}

function handleAndroidNativeState(payload) {
  const native = androidNativePlayback;
  const snapshot = native.snapshot;
  if (payload.initiator === 'system') followAndroidNativeSystemState(payload);
  const trackPath = String(native.items[native.index]?.path || '');
  const nativeState = payload.state;
  snapshot.currentTime = Math.max(0, Number(payload.positionMs) || 0) / 1000;
  // Android plays only while it holds the claim, and only with valid references.
  if (nativeState === 'playing') {
    native.ownership = 'owned';
    native.referenceRetried = false;
  } else if (nativeState !== 'buffering' && nativeState !== 'loading') native.ownerIntent = false;
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
        // The queue continues past the native window, so its next track starts anew.
        startNextTrackPath: queuedBeyondWindow,
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
  if (payload.initiator === 'system' && (payload.reason === 'next' || payload.reason === 'previous')) {
    followAndroidNativeSystemStep(payload);
    return;
  }
  // The web's own loads name items it already selected; only a natural advance is new.
  if (payload.reason !== 'advance' || payload.currentIndex !== native.index + 1) return;
  const outgoing = native.items[native.index];
  const incoming = native.items[payload.currentIndex];
  if (!outgoing || !incoming) return;
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
      // Events echo the applied revision so a replaced or stopped queue cannot overwrite newer state.
      const applied = androidNativePlayback.appliedRevision;
      if (!applied || payload.queueRevision !== applied) return;
      handler(payload);
    });
  }
}
