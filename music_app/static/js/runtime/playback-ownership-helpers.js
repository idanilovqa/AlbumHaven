const PLAYBACK_OWNERSHIP_CHANNEL_NAME = 'albumhaven.playbackOwnership.v1';
const PLAYBACK_OWNERSHIP_HEARTBEAT_MS = 10000;
// A playing tab renews this often: its listen writes need a live lease. A missed renewal frees nothing
// (plays never overlap): only the holder's word that it is silent does.
const PLAYBACK_OWNERSHIP_RENEW_MS = 4000;
// Renewal ticks after which a tab that is not playing gives back a claim it holds (a start that failed,
// autoplay the browser held back: no lease frees it), and an asked tab that never heard the press was over
// looks for itself. A pause drains its listen writes, and a press is over, well before.
const PLAYBACK_OWNERSHIP_SILENT_TICKS = 3;
// Music stops this long after the last answered request was sent, so that a device that
// died blocks nobody for longer: the server lets another start 5 s after this, never earlier.
const PLAYBACK_SILENT_WITHOUT_SERVER_MS = 300000;
// A start nobody answered is asked again this often, with no second press.
const PLAYBACK_OWNERSHIP_RETRY_MS = 2000;
// A burst of seeks (a held arrow key) tells the claim its first place at once and its last when it settles.
const PLAYBACK_POSITION_PUBLISH_MS = 200;
const PLAYBACK_HANDOFF_STORAGE_KEY = 'albumhaven.playbackHandoff.v1';
const PLAYBACK_HANDOFF_WINDOW_MS = 15000;
const PLAYBACK_HANDOFF_RETRY_MS = 100;
// This tab's playback identity, kept when a page unloads so the next page of the same tab renews the
// same claim instead of being refused while the old page's lease runs (Play after a page load gave 409
// and no sound; the unload beacon can always be dropped). Written only at unload
// and taken at load, so a duplicated tab never shares a live tab's identity.
const PLAYBACK_SAME_TAB_STORAGE_KEY = 'albumhaven.playbackSameTab.v1';
let sameTabPlaybackClaim = takeSameTabPlaybackClaim();
let pendingPlaybackOwnershipHandoff = takePlaybackOwnershipHandoffEnvelope();
let playbackOwnershipRuntimeClaimToken = pendingPlaybackOwnershipHandoff.handoff
  ? createPlaybackOwnershipToken() : '';

function createPlaybackOwnershipToken() {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return '';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let token = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const value = (bytes[index] << 16) | ((bytes[index + 1] || 0) << 8) | (bytes[index + 2] || 0);
    token += alphabet[(value >> 18) & 63] + alphabet[(value >> 12) & 63];
    if (index + 1 < bytes.length) token += alphabet[(value >> 6) & 63];
    if (index + 2 < bytes.length) token += alphabet[value & 63];
  }
  return token;
}

function normalizePlaybackOwnershipHandoff(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').toLowerCase();
  const token = String(value.token || '');
  const expiresAt = String(value.expiresAt || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
      || !/^[A-Za-z0-9_-]{43}$/.test(token)
      || !(Date.parse(expiresAt) > Date.now())) return null;
  return { id, token, expiresAt };
}

function takePlaybackOwnershipHandoffEnvelope() {
  if (typeof getSessionStorageItem !== 'function') return { found: false, handoff: null };
  const raw = getSessionStorageItem(PLAYBACK_HANDOFF_STORAGE_KEY);
  if (typeof removeSessionStorageItem === 'function') removeSessionStorageItem(PLAYBACK_HANDOFF_STORAGE_KEY);
  if (!raw) return { found: false, handoff: null };
  try { return { found: true, handoff: normalizePlaybackOwnershipHandoff(JSON.parse(raw)) }; }
  catch (_error) { return { found: true, handoff: null }; }
}

function takeSameTabPlaybackClaim() {
  if (typeof getSessionStorageItem !== 'function') return null;
  const raw = getSessionStorageItem(PLAYBACK_SAME_TAB_STORAGE_KEY);
  if (typeof removeSessionStorageItem === 'function') removeSessionStorageItem(PLAYBACK_SAME_TAB_STORAGE_KEY);
  try {
    const { clientId, claimToken } = JSON.parse(raw || 'null') || {};
    if (/^[0-9a-f-]{36}$/i.test(String(clientId || '')) && /^[A-Za-z0-9_-]{43}$/.test(String(claimToken || ''))) {
      return { clientId: String(clientId), claimToken: String(claimToken) };
    }
  } catch (_error) {
    // A damaged record is no identity.
  }
  return null;
}

/** At unload: the claim this page holds goes to the next page of the same tab. */
function keepPlaybackClaimForThisTab() {
  const ownership = getPlaybackOwnershipState();
  const claim = ownership.activeClaim || ownership.unreleasedClaim || ownership.handedOver?.claim;
  const claimToken = claim?.claimToken;
  // Playing, the leaving beacon says it; not playing, the page says now that it is silent.
  if (claimToken && !isPlaybackClaimRenewable()) {
    ownership.activeClaim = null;
    ownership.unreleasedClaim = claim;
    updatePlaybackSoundPermission();
    void deletePlaybackClaim(claim).catch(() => {});
  }
  if (!claimToken || !ownership.tabId || typeof setSessionStorageItem !== 'function') return false;
  return setSessionStorageItem(PLAYBACK_SAME_TAB_STORAGE_KEY,
    JSON.stringify({ clientId: ownership.tabId, claimToken }));
}

function createPlaybackOwnershipHandoff() {
  const id = createPlaybackOwnershipTabId();
  const token = createPlaybackOwnershipToken();
  if (!id || !token) return null;
  return { id, token, expiresAt: new Date(Date.now() + PLAYBACK_HANDOFF_WINDOW_MS).toISOString() };
}

function getPlaybackOwnershipState() {
  return state.player.ownership ||= { tabId: '', activeClaim: null, lockStatus: 'unlocked',
    blockedReason: '', mirroredTrack: null, heartbeatTimer: 0, initialized: false };
}

function createPlaybackOwnershipTabId() {
  if (window?.crypto?.randomUUID) return String(window.crypto.randomUUID());
  return typeof newMeasuredPlaybackId === 'function' ? newMeasuredPlaybackId() : '';
}

// The playing engine's claim policy from the playback-engine contract; without it, the browser's.
function playingEngine() {
  return typeof currentPlaybackEngine === 'function' ? currentPlaybackEngine() : null;
}

// Inside the APK the bridge handshake decides the engine: the promise to wait for, or null.
function playingEngineHandshake() {
  return typeof playbackEngineHandshake === 'function' ? playbackEngineHandshake() : null;
}

function getPlaybackOwnershipTabId() {
  // An engine that holds its own claim, as Android's does, names the client the claim belongs to.
  const engineClientId = playingEngine()?.claimClientId() || '';
  if (engineClientId) return engineClientId;
  const ownership = getPlaybackOwnershipState();
  return ownership.tabId ||= sameTabPlaybackClaim?.clientId || createPlaybackOwnershipTabId();
}

// The previous page of this tab held playback: its claim is renewed under the same identity. A
// refusal (another client played since) leaves this page a new client.
async function renewSameTabPlaybackClaim(prepared, track) {
  const inherited = sameTabPlaybackClaim;
  const ownership = getPlaybackOwnershipState();
  if (!inherited || getPlaybackOwnershipTabId() !== inherited.clientId) return null;
  try {
    const result = await requestPlaybackClaim({ protocol: 1, clientId: inherited.clientId,
      clientSurface: 'private_web', claimToken: inherited.claimToken, state: 'playing',
      track: prepared.track, ...positionField(track) });
    sameTabPlaybackClaim = null;
    return result;
  } catch (error) {
    // Nobody answered: the next attempt asks again with the same identity.
    if (error?.unanswered) throw error;
    sameTabPlaybackClaim = null;
    ownership.tabId = createPlaybackOwnershipTabId();
    return null;
  }
}

function normalizePlaybackOwnershipTrack(track) {
  if (!track || typeof track !== 'object') return null;
  return { title: String(track.title || ''), artist: String(track.artist || ''),
    album: String(track.album || ''), artworkUrl: track.artworkUrl || null };
}

async function playbackOwnershipRequest(method, url, payload, timeoutMs = PLAYBACK_OWNERSHIP_HEARTBEAT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
      signal: controller.signal,
      // A closing page still delivers "I am silent": without it nobody can play.
      ...(method === 'DELETE' ? { keepalive: true } : {}),
      ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) })
      .catch(markUnanswered);
    if (!response.ok) {
      const error = new Error('Playback ownership is unavailable.');
      error.status = response.status;
      // An overloaded server's answer says no more than no answer does.
      error.unanswered = response.status >= 500 || response.status === 429;
      // A refusal that names when to ask again ends by itself: a leaving page's output still drains.
      const retryAfterSeconds = Number(response.headers?.get?.('Retry-After'));
      if (retryAfterSeconds > 0) error.retryAfterMs = retryAfterSeconds * 1000;
      throw error;
    }
    return await response.json().catch(markUnanswered);
  } finally { clearTimeout(timeout); }
}

function markUnanswered(error) {
  throw Object.assign(new Error(`Playback ownership request was not answered: ${error?.message || error}`),
    { unanswered: true });
}

function isShellPlaybackUnavailable() {
  return typeof isAndroidPlaybackUnavailable === 'function' && isAndroidPlaybackUnavailable();
}

// The player shows only the lock, its reason and the mirrored track, so a heartbeat, broadcast or
// renewal that leaves them as they were repaints nothing.
function playbackOwnershipPresentation() {
  const { lockStatus, blockedReason, mirroredTrack: track } = getPlaybackOwnershipState();
  return [lockStatus, blockedReason, track?.title, track?.artist, track?.album, track?.artworkUrl].join('\0');
}

function updatePlayerUiIfOwnershipPresentationChanged(previousPresentation) {
  if (playbackOwnershipPresentation() !== previousPresentation && typeof updatePlayerUi === 'function') {
    updatePlayerUi();
  }
}

function clearBlockedPlaybackState() {
  const ownership = getPlaybackOwnershipState();
  ownership.lockStatus = 'unlocked';
  ownership.blockedReason = '';
  ownership.mirroredTrack = null;
}

function stopPlaybackOwnershipHeartbeat() {
  const ownership = getPlaybackOwnershipState();
  if (ownership.heartbeatTimer) clearInterval(ownership.heartbeatTimer);
  ownership.heartbeatTimer = 0;
}

function losePlaybackOwnership(reason = 'ownership-lost', updateUi = true) {
  const ownership = getPlaybackOwnershipState();
  ownership.requestVersion = (ownership.requestVersion || 0) + 1;
  endClaimWait();
  ownership.activeClaim = null;
  updatePlaybackSoundPermission();
  if (ownership.expiryTimer) clearTimeout(ownership.expiryTimer);
  ownership.lockStatus = 'locked';
  ownership.blockedReason = 'playback_unavailable';
  const offset = typeof getPlayerPlaybackSnapshot === 'function'
    ? getPlayerPlaybackSnapshot().currentTime : 0;
  if (typeof closeListenSegment === 'function') closeListenSegment(offset);
  if (!state.player.listenSession?.paused_at_unix_ms && typeof markListenSessionPaused === 'function') {
    markListenSessionPaused(offset);
  }
  let stopped = Promise.resolve();
  if (reason === 'ownership-handover') {
    // Asked by Play here elsewhere it only falls silent: stopping would close the socket it answers on.
    stopped = Promise.resolve(pauseStreamingPlayback());
  } else if (typeof stopStreamingPlayback === 'function') {
    stopped = Promise.resolve(stopStreamingPlayback(reason, { preserveSnapshot: true }));
  }
  void stopped.catch(() => {});
  if (updateUi && typeof updatePlayerUi === 'function') updatePlayerUi();
  return stopped;
}

// A claim dropped for a failure is still the server's holder, and nobody starts over a quiet holder:
// once this tab's audio has stopped, it says so.
function giveBackLostClaim(claim, stopped) {
  const ownership = getPlaybackOwnershipState();
  void stopped.then(() => {
    if (ownership.activeClaim) return;
    ownership.unreleasedClaim = claim;
    retryPlaybackRelease();
  }, () => {});
}

/**
 * How long this page may sound: not before its grant, and for five minutes from before the last answered
 * request was sent. Both clocks, as the audio thread checks both.
 */
function playbackSoundPermission() {
  const claim = getPlaybackOwnershipState().activeClaim;
  if (playingEngine()?.holdsOwnClaim || !holdsPlaybackClaim() || !claim.soundUntilWallMs) {
    return { untilMs: 0, forMs: 0 };
  }
  return { untilMs: claim.soundUntilWallMs, forMs: Math.max(0, claim.soundDeadline - performance.now()) };
}

function updatePlaybackSoundPermission() {
  if (typeof syncStreamingSoundPermission === 'function') syncStreamingSoundPermission();
}

/** Whether a press may load its stream while it asks: only where the audio thread holds it until the grant. */
function loadsSilentlyWhileAsking() {
  // Inside the APK the handshake may name Android's player, whose sound this page cannot hold.
  return !playingEngine()?.holdsOwnClaim && !playingEngineHandshake();
}

// An outage start waits and then starts by itself, with no second press. A newer press, a pause or a
// takeover ends the wait.
function waitToAskAgain(delayMs = PLAYBACK_OWNERSHIP_RETRY_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    getPlaybackOwnershipState().wakeClaimWait = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function endClaimWait() {
  const ownership = getPlaybackOwnershipState();
  ownership.wakeClaimWait?.();
  ownership.wakeClaimWait = null;
}

// Sent until answered, as nothing else frees the claim: a give-back nobody answered, or the claim this
// tab's previous page left while this page is not playing. A press never waits for it: a new claim is a new
// token, which a late give-back cannot delete. Only the inherited token, which a press may renew, is in turn.
function retryPlaybackRelease() {
  const ownership = getPlaybackOwnershipState();
  if (ownership.activeClaim || ownership.releasing) return;
  let claim = ownership.unreleasedClaim;
  if (!claim && sameTabPlaybackClaim?.clientId === ownership.tabId
      && !pendingPlaybackOwnershipHandoff?.handoff && !isPlaybackClaimRenewable()) {
    claim = sameTabPlaybackClaim;
  }
  if (!claim) return;
  const version = ownership.requestVersion || 0;
  const previousOperation = ownership.pendingOperation;
  ownership.releasing = true;
  const operation = (async () => {
    await previousOperation;
    if (ownership.activeClaim || version !== (ownership.requestVersion || 0)) return false;
    try {
      await deletePlaybackClaim(claim);
    } catch (error) {
      if (error?.unanswered) return false;
    }
    if (ownership.unreleasedClaim === claim) ownership.unreleasedClaim = null;
    if (sameTabPlaybackClaim === claim) sameTabPlaybackClaim = null;
    announcePlaybackOwnership();
    return true;
  })().finally(() => { ownership.releasing = false; });
  if (claim === sameTabPlaybackClaim) ownership.pendingOperation = operation;
}

// The pause ends any start still waiting on the browser, and is what makes this tab silent.
async function giveBackSilentClaim() {
  const ownership = getPlaybackOwnershipState();
  const claim = ownership.activeClaim;
  if (typeof pauseStreamingPlayback === 'function') await pauseStreamingPlayback();
  if (ownership.activeClaim === claim && !isPlaybackClaimRenewable()) await releasePlaybackOwnership();
}

function syncMirroredPlaybackState(snapshot) {
  const ownership = getPlaybackOwnershipState();
  const previousPresentation = playbackOwnershipPresentation();
  if (snapshot?.is_playing_elsewhere) {
    if (ownership.blockedReason !== 'playing_in_another_tab') losePlaybackOwnership('ownership-takeover', false);
    ownership.lockStatus = 'locked';
    ownership.blockedReason = 'playing_in_another_tab';
    ownership.mirroredTrack = normalizePlaybackOwnershipTrack(snapshot.track);
  } else if (!ownership.activeClaim && !isShellPlaybackUnavailable()) {
    clearBlockedPlaybackState();
  }
  updatePlayerUiIfOwnershipPresentationChanged(previousPresentation);
}

async function handlePlaybackOwnershipEvent() {
  const ownership = getPlaybackOwnershipState();
  const version = ownership.requestVersion || 0;
  try {
    // Inside the APK the native client may already own playback a reloaded document re-attaches to;
    // only the handshake names it, so asking before it would report this app's own playback as elsewhere.
    const handshake = playingEngineHandshake();
    if (handshake) await handshake;
    const snapshot = await playbackOwnershipRequest('GET',
      `/playback/state?client_id=${encodeURIComponent(getPlaybackOwnershipTabId())}`);
    if (version !== (ownership.requestVersion || 0)) return null;
    syncMirroredPlaybackState(snapshot);
    return snapshot;
  } catch (_error) {
    // A failed read never grants playback; acquisition still requires PUT.
    return null;
  }
}

function announcePlaybackOwnership(type = 'changed', clientId = '') {
  getPlaybackOwnershipState().channel?.postMessage(clientId ? { type, clientId } : { type });
}

/**
 * Another tab of this browser says ownership changed, or that it took over a client: that one stops at
 * once. The server names that client only to a taker of its own account.
 */
function receivePlaybackOwnershipMessage(event) {
  const ownership = getPlaybackOwnershipState();
  if (event?.data?.type === 'taken-over' && ownership.activeClaim
      && event.data.clientId === getPlaybackOwnershipTabId()) {
    losePlaybackOwnership('ownership-takeover', false);
    ownership.blockedReason = 'playing_in_another_tab';
  }
  return handlePlaybackOwnershipEvent();
}

function stagePlaybackOwnershipHandoff(completion = null, playbackSnapshot = null) {
  const ownership = getPlaybackOwnershipState();
  const claim = ownership.activeClaim;
  const playback = playbackSnapshot
    || (typeof getPlayerPlaybackSnapshot === 'function' ? getPlayerPlaybackSnapshot() : null);
  if (ownership.handoffAttempted || !claim?.claimToken || playback?.paused || playback?.ended
      || typeof navigator?.sendBeacon !== 'function') return false;
  ownership.handoffAttempted = true;
  updatePlaybackSoundPermission();
  const handoff = createPlaybackOwnershipHandoff();
  if (!handoff || typeof setSessionStorageItem !== 'function'
      || !setSessionStorageItem(PLAYBACK_HANDOFF_STORAGE_KEY, JSON.stringify(handoff))) return false;
  let accepted = false;
  try {
    accepted = navigator.sendBeacon('/playback/state/handoff', new Blob([JSON.stringify({
      protocol: 1,
      clientId: getPlaybackOwnershipTabId(),
      claimToken: claim.claimToken,
      csrf_token: window.readSessionCsrfCookie?.() || '',
      handoff: { id: handoff.id, token: handoff.token },
      completion,
    })], { type: 'application/json' }));
  } catch (_error) {
    accepted = false;
  }
  if (!accepted && typeof removeSessionStorageItem === 'function') {
    removeSessionStorageItem(PLAYBACK_HANDOFF_STORAGE_KEY);
  }
  return accepted;
}

function isPlaybackClaimRenewable() {
  const playback = typeof getPlayerPlaybackSnapshot === 'function' ? getPlayerPlaybackSnapshot() : null;
  return !playback?.paused && !playback?.ended;
}

// Play here starts where the claim says the song is, so a seek and a song's first frame say so now,
// not at the next renewal. A claim request on its way carries the older place: this follows it.
function publishPlaybackPositionSoon() {
  const ownership = getPlaybackOwnershipState();
  const inBurst = Boolean(ownership.positionTimer);
  clearTimeout(ownership.positionTimer);
  ownership.positionTimer = setTimeout(() => {
    ownership.positionTimer = 0;
    return inBurst ? publishPlaybackPositionNow() : undefined;
  }, PLAYBACK_POSITION_PUBLISH_MS);
  if (!inBurst) void publishPlaybackPositionNow();
}

async function publishPlaybackPositionNow() {
  const ownership = getPlaybackOwnershipState();
  await ownership.pendingOperation;
  // A renewal that took this turn read the place before this one did: it is waited for, not joined.
  while (ownership.renewing) await ownership.pendingOperation;
  if (ownership.activeClaim && isPlaybackClaimRenewable()) await refreshPlaybackOwnershipClaim();
}

function startPlaybackOwnershipHeartbeat() {
  const ownership = getPlaybackOwnershipState();
  if (ownership.heartbeatTimer || ownership.recoveryPromise) return;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let silentTicks = 0;
  ownership.heartbeatTimer = setInterval(() => {
    if (ownership.recoveryPromise) return;
    if (ownership.activeClaim && isPlaybackClaimRenewable()) {
      silentTicks = 0;
      void refreshPlaybackOwnershipClaim();
      return;
    }
    const waits = ownership.activeClaim ? !state.player.selectedTrack : Boolean(ownership.handedOver);
    silentTicks = waits ? silentTicks + 1 : 0;
    if (silentTicks >= PLAYBACK_OWNERSHIP_SILENT_TICKS) {
      silentTicks = 0;
      void Promise.resolve(ownership.activeClaim ? giveBackSilentClaim() : settlePlaybackHandover()).catch(() => {});
    }
    if (ownership.activeClaim) return;
    retryPlaybackRelease();
    // Without a claim, what another client plays is read every heartbeat, not every renewal tick.
    const now = performance.now();
    if (now - checkedAt < PLAYBACK_OWNERSHIP_HEARTBEAT_MS - 100) return;
    checkedAt = now;
    void handlePlaybackOwnershipEvent();
  }, PLAYBACK_OWNERSHIP_RENEW_MS);
}

function recoverPlaybackOwnership(callback) {
  const ownership = getPlaybackOwnershipState();
  stopPlaybackOwnershipHeartbeat();
  const recovery = Promise.resolve().then(callback);
  ownership.recoveryPromise = recovery;
  return recovery.finally(() => {
    if (ownership.recoveryPromise !== recovery) return;
    ownership.recoveryPromise = null;
    startPlaybackOwnershipHeartbeat();
  });
}

async function playbackOwnershipTrack(track, previous = null) {
  if (!track?.path) throw new Error('Playback track is unavailable.');
  let playbackRef = previous?.path === track.path ? previous.track.playbackRef : null;
  if (!playbackRef || Date.parse(previous?.referenceExpiresAt || '') <= Date.now()) {
    const refs = await playbackOwnershipRequest('POST', '/playback/refs', { protocol: 1,
      tracks: [{ clientKey: getPlaybackOwnershipTabId(), path: track.path }] });
    if (refs.protocol !== 1 || refs.tracks?.length !== 1 || !refs.tracks[0].playbackRef) {
      throw new Error('Playback reference is unavailable.');
    }
    playbackRef = refs.tracks[0].playbackRef;
    previous = { referenceExpiresAt: refs.expiresAt };
  }
  return { path: track.path, referenceExpiresAt: previous.referenceExpiresAt,
    track: { ...normalizePlaybackOwnershipTrack(track), artworkUrl: null, playbackRef } };
}

// A start is one request (the shortened wait): with no reference kept, the claim names the
// song by its path and the same answer brings the reference.
function claimedPlaybackTrack(track, previous = null) {
  if (!track?.path) throw new Error('Playback track is unavailable.');
  const named = { ...normalizePlaybackOwnershipTrack(track), artworkUrl: null };
  const playbackRef = previous?.path === track.path ? previous.track?.playbackRef : null;
  if (playbackRef && Date.parse(previous.referenceExpiresAt || '') > Date.now()) {
    return { path: track.path, referenceExpiresAt: previous.referenceExpiresAt, track: { ...named, playbackRef } };
  }
  return { path: track.path, track: { ...named, path: track.path } };
}

async function deletePlaybackClaim(claim) {
  if (!claim?.claimToken) return;
  await playbackOwnershipRequest('DELETE', '/playback/state', {
    protocol: 1, clientId: getPlaybackOwnershipTabId(), claimToken: claim.claimToken,
  });
}

async function requestPlaybackClaim(payload, timeoutMs) {
  // The answer's expiresAt is on the server's clock, so this document times the lease on its own
  // monotonic clock, from before the request: the server starts the lease before it answers.
  const sentAt = performance.now();
  const sentWallMs = Date.now();
  return { ...await playbackOwnershipRequest('PUT', '/playback/state', { ...payload, silencesItself: true }, timeoutMs),
    sentAt, sentWallMs };
}

function acceptPlaybackClaim(result, prepared) {
  if (result.protocol !== 1 || !result.claimToken || !Number.isFinite(Date.parse(result.expiresAt))
      || !(Number.isFinite(result.leaseMs) && result.leaseMs > 0)) {
    throw new Error('Playback claim is unavailable.');
  }
  const ownership = getPlaybackOwnershipState();
  // Every acquire and heartbeat says afresh whether listen writes can reach Last.fm; null when it does not say.
  const scrobblingAvailable = typeof result.scrobbling?.available === 'boolean' ? result.scrobbling.available : null;
  const leaseDeadline = result.sentAt + result.leaseMs;
  let claimed = prepared;
  if (result.playbackRef) {
    const { path: _named, ...track } = prepared.track;
    claimed = { path: prepared.path, referenceExpiresAt: result.referenceExpiresAt,
      track: { ...track, playbackRef: result.playbackRef } };
  }
  const claim = { ...claimed, claimToken: result.claimToken, leaseDeadline, scrobblingAvailable,
    soundDeadline: result.sentAt + PLAYBACK_SILENT_WITHOUT_SERVER_MS,
    soundUntilWallMs: result.sentWallMs + PLAYBACK_SILENT_WITHOUT_SERVER_MS };
  // A switch claims the pressed song while the one before still sounds: a handover names that one.
  if (ownership.activeClaim?.path && ownership.activeClaim.path !== claim.path) {
    ownership.previousClaim = ownership.activeClaim;
  }
  ownership.releasedClaim = null;
  ownership.handedOver = null;
  ownership.unreleasedClaim = null;
  ownership.claimInDoubt = false;
  // This tab's own claim now: the one its previous page left is void.
  sameTabPlaybackClaim = null;
  ownership.activeClaim = claim;
  updatePlaybackSoundPermission();
  // A page that was refused its previous page's claim is a new client.
  if (typeof connectStreamingSilenceRelay === 'function') connectStreamingSilenceRelay();
  const previousPresentation = playbackOwnershipPresentation();
  clearBlockedPlaybackState();
  if (ownership.expiryTimer) clearTimeout(ownership.expiryTimer);
  ownership.expiryTimer = setTimeout(() => expirePlaybackClaim(claim),
    Math.max(0, leaseDeadline - performance.now()));
  startPlaybackOwnershipHeartbeat();
  announcePlaybackOwnership();
  updatePlayerUiIfOwnershipPresentationChanged(previousPresentation);
}

async function expirePlaybackClaim(claim) {
  const ownership = getPlaybackOwnershipState();
  // A claim request in flight confirms or drops this claim itself within its request deadline,
  // and a newer request queued behind it decides ownership in its turn.
  const version = ownership.requestVersion || 0;
  await ownership.pendingOperation;
  if (ownership.activeClaim !== claim || version !== (ownership.requestVersion || 0)) return;
  // A jump in this document's clock can reach this deadline while the server's lease still runs,
  // so a playing claim asks the server once; only its answer can drop it.
  if (isPlaybackClaimRenewable()) await refreshPlaybackOwnershipClaim();
  else giveBackLostClaim(claim, losePlaybackOwnership());
}

async function refreshPlaybackOwnershipClaim(track = null) {
  const ownership = getPlaybackOwnershipState();
  if (!ownership.activeClaim || ownership.renewing) return false;
  const version = ownership.requestVersion || 0;
  const previousOperation = ownership.pendingOperation;
  ownership.renewing = true;
  const operation = (async () => {
    await previousOperation;
    if (version !== (ownership.requestVersion || 0)) return false;
    const claim = ownership.activeClaim;
    if (!claim) return false;
    try {
      // While a switch is pending the claim is the pressed song's: the current one is the song it replaces.
      const claimed = track || state.player.selectedTrack || state.player.current;
      const prepared = claimedPlaybackTrack(claimed, claim);
      if (version !== (ownership.requestVersion || 0)) return false;
      const result = await requestPlaybackClaim({ protocol: 1,
        clientId: getPlaybackOwnershipTabId(), clientSurface: 'private_web', claimToken: claim.claimToken,
        state: 'playing', track: prepared.track, ...positionField(claimed) });
      if (ownership.activeClaim !== claim || version !== (ownership.requestVersion || 0)) return false;
      acceptPlaybackClaim(result, prepared);
      return true;
    } catch (error) {
      // No answer is not a refusal: it plays on, at most its five minutes, and the heartbeat asks again.
      if (error?.unanswered) return false;
      if (ownership.activeClaim === claim && version === (ownership.requestVersion || 0)) {
        const stopped = losePlaybackOwnership();
        // Taken over: show which client plays now, as "Playing in another tab".
        if (error?.status === 409) await handlePlaybackOwnershipEvent();
        else giveBackLostClaim(claim, stopped);
      }
      return false;
    }
  })().finally(() => { ownership.renewing = false; });
  ownership.pendingOperation = operation;
  return operation;
}

async function acquirePlaybackOwnershipHandoff(prepared, handoff) {
  playbackOwnershipRuntimeClaimToken ||= createPlaybackOwnershipToken();
  if (!playbackOwnershipRuntimeClaimToken) throw new Error('Playback handoff is unavailable.');
  const deadline = Math.min(Date.parse(handoff.expiresAt), Date.now() + PLAYBACK_HANDOFF_WINDOW_MS);
  while (Date.now() < deadline) {
    try {
      return await requestPlaybackClaim({ protocol: 1,
        clientId: getPlaybackOwnershipTabId(), clientSurface: 'private_web',
        claimToken: playbackOwnershipRuntimeClaimToken, state: 'playing', track: prepared.track,
        handoff: { id: handoff.id, token: handoff.token } },
      Math.max(1, Math.min(PLAYBACK_OWNERSHIP_HEARTBEAT_MS, deadline - Date.now())));
    } catch (error) {
      if (error?.status && error.status !== 409) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(PLAYBACK_HANDOFF_RETRY_MS, remaining)));
    }
  }
  throw new Error('Playback handoff expired.');
}

async function claimPlaybackOwnership(track, options = {}) {
  const ownership = getPlaybackOwnershipState();
  const version = ownership.requestVersion = (ownership.requestVersion || 0) + 1;
  endClaimWait();
  updatePlaybackSoundPermission();
  const previousOperation = ownership.pendingOperation;
  const handoff = options.handoff || null;
  const operation = (async () => {
    await previousOperation;
    // Inside the APK only the handshake says whether Android plays natively or at all.
    const handshake = playingEngineHandshake();
    if (handshake) await handshake;
    if (version !== ownership.requestVersion) return false;
    if (playingEngine()?.holdsOwnClaim) return mayEngineStart(options, version);
    for (;;) {
      const claim = ownership.activeClaim;
      try {
        if (isShellPlaybackUnavailable()) throw new Error('Playback is unavailable in this app.');
        const prepared = claimedPlaybackTrack(track, claim || ownership.releasedClaim);
        const inherited = !claim && !options.takeover && sameTabPlaybackClaim
          ? await renewSameTabPlaybackClaim(prepared, track)
          : null;
        const result = inherited || (handoff
          ? await acquirePlaybackOwnershipHandoff(prepared, handoff)
          : await requestPlaybackClaim({ protocol: 1,
            clientId: getPlaybackOwnershipTabId(), clientSurface: 'private_web',
            claimToken: claim?.claimToken || null, state: 'playing', track: prepared.track,
            ...(options.takeover && !claim ? { takeover: true } : {}),
            ...positionField(track) }));
        if (version !== ownership.requestVersion) {
          if (!claim) await discardPlaybackClaim(result);
          return false;
        }
        acceptPlaybackClaim(result, prepared);
        return true;
      } catch (error) {
        if (version !== ownership.requestVersion) return false;
        if (error?.unanswered && !handoff) {
          // A held claim plays on inside its five minutes. Without one the audio thread holds the stream.
          if (claim && holdsPlaybackClaim()) return true;
          await waitToAskAgain();
          if (version !== ownership.requestVersion) return false;
          continue;
        }
        // The page that played said it is leaving: it is silent once its output drains, and the one
        // press starts then. The server names the wait only while it drains.
        if (error?.status === 409 && error.retryAfterMs && !claim && !handoff) {
          await waitToAskAgain(error.retryAfterMs);
          if (version !== ownership.requestVersion) return false;
          continue;
        }
        const stopped = losePlaybackOwnership();
        if (claim && error?.status !== 409) giveBackLostClaim(claim, stopped);
        await handlePlaybackOwnershipEvent();
        if (options.showBlockedToast !== false) notifyBlockedPlaybackStart();
        return false;
      }
    }
  })();
  ownership.pendingOperation = operation;
  return operation;
}

/** A grant this tab will not use: given back, and again until the server answers. */
async function discardPlaybackClaim(result) {
  await deletePlaybackClaim(result).catch((error) => {
    if (error?.unanswered) getPlaybackOwnershipState().unreleasedClaim = result;
  });
}

/**
 * An engine with its own claim (Android's) sounds while it asks for one, and installed apps cannot be
 * changed from here: without a claim of its own it is let start only once the server says nobody plays.
 */
async function mayEngineStart(options, version) {
  if (playingEngine().ownsPlayback()) return true;
  const ownership = getPlaybackOwnershipState();
  for (;;) {
    try {
      const snapshot = await playbackOwnershipRequest('GET',
        `/playback/state?client_id=${encodeURIComponent(getPlaybackOwnershipTabId())}`);
      if (version !== ownership.requestVersion) return false;
      if (!snapshot.is_playing_elsewhere) return true;
      syncMirroredPlaybackState(snapshot);
      break;
    } catch (error) {
      // No answer is no proof that nobody plays: it waits for one.
      if (version !== ownership.requestVersion) return false;
      if (!error?.unanswered) break;
      await waitToAskAgain();
      if (version !== ownership.requestVersion) return false;
    }
  }
  if (options.showBlockedToast !== false) notifyBlockedPlaybackStart();
  return false;
}

/**
 * Only then may this client sound before the server answers: nobody else can have started. A page that
 * said it was leaving, or is back from the page cache and has not asked yet, may already have been replaced.
 */
function holdsPlaybackClaim() {
  const engine = playingEngine();
  if (engine?.holdsOwnClaim) return Boolean(engine.ownsPlayback());
  const ownership = getPlaybackOwnershipState();
  return Boolean(ownership.activeClaim?.claimToken) && !ownership.handoffAttempted && !ownership.claimInDoubt;
}

async function releasePlaybackOwnership() {
  // An engine that holds its own claim releases it once its listen writes drain.
  if (playingEngine()?.holdsOwnClaim) return false;
  const ownership = getPlaybackOwnershipState();
  const version = ownership.requestVersion = (ownership.requestVersion || 0) + 1;
  endClaimWait();
  const claim = ownership.activeClaim;
  if (claim && typeof drainPlaybackSessionRequests === 'function') {
    await drainPlaybackSessionRequests(claim.claimToken);
  }
  if (version !== ownership.requestVersion) return false;
  const previousOperation = ownership.pendingOperation;
  const operation = (async () => {
    await previousOperation;
    if (version !== ownership.requestVersion) return false;
    ownership.activeClaim = null;
    updatePlaybackSoundPermission();
    // Play here elsewhere can still ask the tab that just paused.
    if (claim) ownership.releasedClaim = claim;
    if (ownership.expiryTimer) clearTimeout(ownership.expiryTimer);
    clearBlockedPlaybackState();
    if (claim) await discardPlaybackClaim(claim);
    announcePlaybackOwnership();
    return Boolean(claim);
  })();
  ownership.pendingOperation = operation;
  return operation;
}

function notifyBlockedPlaybackStart() {
  if (typeof showToast === 'function') {
    showToast(getPlaybackOwnershipState().blockedReason === 'playing_in_another_tab'
      ? 'Playback is active in another tab.' : 'Playback is unavailable.', 'error', 2800);
  }
}

/**
 * A loaded page resumes by itself only what this tab was playing: its last page handed
 * on moments ago. A new tab, a restarted browser and a hand-over that was lost open paused.
 */
function canThisTabResumePlayback() {
  return Boolean(pendingPlaybackOwnershipHandoff?.handoff);
}

function canRestoreActivePlayback(parsedState) {
  const stored = pendingPlaybackOwnershipHandoff;
  pendingPlaybackOwnershipHandoff = null;
  if (stored?.found && !stored.handoff) return false;
  return recoverPlaybackOwnership(() => claimPlaybackOwnership(parsedState?.track, {
    showBlockedToast: false,
    handoff: stored?.handoff || null,
  }));
}

function restorePlaybackOwnershipFromPageCache(playbackSnapshot = null) {
  const ownership = getPlaybackOwnershipState();
  // Back from the page cache, this page is the tab's live holder again: nothing is handed on.
  if (typeof removeSessionStorageItem === 'function') removeSessionStorageItem(PLAYBACK_SAME_TAB_STORAGE_KEY);
  ownership.handoffAttempted = false;
  ownership.claimInDoubt = Boolean(ownership.activeClaim);
  updatePlaybackSoundPermission();
  const stored = takePlaybackOwnershipHandoffEnvelope();
  const handoff = stored.handoff;
  if (!handoff) {
    if (!state.player.current || playbackSnapshot?.paused !== false
        || playbackSnapshot?.ended || !isActivePlaybackOwner()) return false;
    return recoverPlaybackOwnership(() => claimPlaybackOwnership(
      state.player.current, { showBlockedToast: false },
    ));
  }
  if (!state.player.current) return false;
  const runtimeClientId = createPlaybackOwnershipTabId();
  const runtimeClaimToken = createPlaybackOwnershipToken();
  if (!runtimeClientId || !runtimeClaimToken) return false;
  return recoverPlaybackOwnership(() => {
    ownership.tabId = runtimeClientId;
    playbackOwnershipRuntimeClaimToken = runtimeClaimToken;
    ownership.activeClaim = null;
    updatePlaybackSoundPermission();
    if (ownership.expiryTimer) clearTimeout(ownership.expiryTimer);
    return claimPlaybackOwnership(state.player.current, { showBlockedToast: false, handoff });
  });
}

function canStartPlaybackInThisTab(track, options = {}) {
  return claimPlaybackOwnership(track, { takeover: options.takeover === true });
}

function playbackToHandOver(starting) {
  const sounding = typeof getSoundingStreamingPlayback === 'function' && getSoundingStreamingPlayback();
  if (sounding) return sounding;
  // With no stream yet, a stopped player is at its place and a first start at the place it starts from.
  if (!state.player.current) return starting;
  const snapshot = getPlayerPlaybackSnapshot();
  return { track: state.player.current, seconds: snapshot.currentTime, durationSeconds: snapshot.duration };
}

/**
 * Play here elsewhere still wants this tab to stop: it stops and, once its output is
 * silent, answers the song that sounded and where, with its claim's token. No path crosses the socket.
 */
function answerPlaybackHandover(requestId) {
  const ownership = getPlaybackOwnershipState();
  const answering = fallSilentAndAnswer(requestId);
  ownership.answering = answering;
  return answering;
}

async function fallSilentAndAnswer(requestId) {
  const ownership = getPlaybackOwnershipState();
  // A start's first claim may still be on its way.
  if (!ownership.activeClaim && !ownership.releasedClaim) await ownership.pendingOperation;
  const claim = ownership.activeClaim || ownership.handedOver?.claim || ownership.releasedClaim;
  const answerSilent = () => sendStreamingHandoverAnswer({ type: 'handover-silent', requestId });
  // A first start has no stream yet: read it before the press is cancelled.
  const starting = { track: state.player.selectedTrack, seconds: state.player.selectedStartSeconds,
    durationSeconds: state.player.selectedTrack?.durationSeconds };
  if (!claim?.claimToken || !playbackToHandOver(starting).track?.path) {
    // Nothing to hand on (a page just reloaded): with nothing sounding or starting it says so, once what
    // it last rendered left the output.
    if (starting.track || isPlaybackClaimRenewable()) return;
    if (typeof drainStreamingOutput === 'function') await drainStreamingOutput();
    if (!isPlaybackClaimRenewable()) answerSilent();
    return;
  }
  const wasPlaying = ownership.handedOver?.wasPlaying || Boolean(starting.track) || isPlaybackClaimRenewable();
  if (typeof cancelPendingPlayerSelection === 'function') cancelPendingPlayerSelection();
  const drained = typeof silenceStreamingPlaybackForHandover === 'function'
    ? await silenceStreamingPlaybackForHandover()
    : async () => true;
  // Read only now: what was rendered until the silence is what was heard.
  const sounding = playbackToHandOver(starting);
  const { track } = sounding;
  const known = [claim, ownership.previousClaim].find((held) => held?.path === track.path) || null;
  // As a claim taken over: no save and no release follows it with the token it hands on.
  losePlaybackOwnership('ownership-handover', false);
  ownership.handedOver = { claim, wasPlaying,
    starting: starting.track ? starting : ownership.handedOver?.starting };
  ownership.blockedReason = 'playing_in_another_tab';
  ownership.mirroredTrack = normalizePlaybackOwnershipTrack(track);
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
  // Without proof of silence there is no answer.
  if (!drained) return;
  const [silent, prepared] = await Promise.all([drained(),
    playbackOwnershipTrack(track, known).catch(() => null)]);
  if (!silent) return;
  if (!prepared) {
    answerSilent();
    return;
  }
  const durationMs = Math.round((Number(sounding.durationSeconds) || 0) * 1000);
  const ms = Math.max(0, Math.round((Number(sounding.seconds) || 0) * 1000));
  sendStreamingHandoverAnswer({
    type: 'handover-answer',
    requestId,
    claimToken: claim.claimToken,
    track: prepared.track,
    position: durationMs > 0 ? { ms: Math.min(ms, durationMs), durationMs } : null,
  });
}

/**
 * The press that asked this tab is over: it shows who plays now and, if nobody took over, plays on. It
 * plays on as a new claim, which voids the answer it gave: a taker still on its way is refused, not doubled.
 */
async function settlePlaybackHandover() {
  const ownership = getPlaybackOwnershipState();
  if (ownership.answering) await Promise.resolve(ownership.answering).catch(() => {});
  const snapshot = await handlePlaybackOwnershipEvent();
  const handedOver = ownership.handedOver;
  // No answer says nothing: the heartbeat asks again.
  if (!handedOver || !snapshot) return;
  ownership.handedOver = null;
  if (!snapshot.is_playing_here) return;
  if (isPlaybackClaimRenewable()) return;
  // The server still holds it for this tab: given back, unless the new claim replaces it.
  ownership.unreleasedClaim = handedOver.claim;
  const { starting } = handedOver;
  if (!handedOver.wasPlaying) retryPlaybackRelease();
  else if (starting && typeof playTrackFromPayload === 'function') {
    await playTrackFromPayload(starting.track, { startSeconds: Number(starting.seconds) || 0 });
  } else if (typeof togglePlayerPlayback === 'function') {
    togglePlayerPlayback({ focusTimelineOnResume: false });
  }
}

/**
 * Play while another client plays (playback.claim.takeover): that client's
 * song continues here from where it last said it was, and this claim replaces its claim.
 */
function takeOverPlaybackHere() {
  const ownership = getPlaybackOwnershipState();
  if (ownership.takingOver) return ownership.takingOver;
  ownership.takingOver = takeOverPlayback().finally(() => { ownership.takingOver = null; });
  return ownership.takingOver;
}

async function takeOverPlayback() {
  // Inside the APK only the handshake says whether Android plays natively, and whether it can take over.
  const handshake = playingEngineHandshake();
  if (handshake) await handshake;
  // Decided before any request: the confirmed one stops the other device, whatever happens here after it.
  if (!canTakePlaybackOverHere()) {
    notifyBlockedPlaybackStart();
    return false;
  }
  return takeOverAtConfirmedPlace();
}

/**
 * One request: the server asks the playing client, which stops and says what
 * sounds and where, and moves the claim here with that answer. Without its word it refuses.
 */
async function takeOverAtConfirmedPlace() {
  const ownership = getPlaybackOwnershipState();
  const version = ownership.requestVersion = (ownership.requestVersion || 0) + 1;
  const native = Boolean(playingEngine()?.holdsOwnClaim);
  let result;
  try {
    result = await requestPlaybackClaim({ protocol: 1, state: 'playing', clientId: getPlaybackOwnershipTabId(),
      clientSurface: native ? 'mobile' : 'private_web', takeover: true, confirm: true });
  } catch (error) {
    if (version === ownership.requestVersion) {
      if (error?.status !== 422) notifyBlockedPlaybackStart();
      else if (typeof showToast === 'function') showToast('That song cannot be opened here.', 'error', 2800);
      void handlePlaybackOwnershipEvent();
    }
    return false;
  }
  if (version !== ownership.requestVersion) {
    // A later press here decides what plays.
    if (result.claimToken) await discardPlaybackClaim(result);
    return false;
  }
  if (!result.claimToken) {
    // It stopped meanwhile: the player shows what holds now, and the next Play starts here.
    syncMirroredPlaybackState(result);
    return false;
  }
  const payload = takenOverTrack(result);
  const startSeconds = result.position ? result.position.ms / 1000 : 0;
  state.player.playbackQueue = null;
  // An engine with its own claim (Android's) starts there by a takeover of the claim now under its client.
  if (native) {
    let started = false;
    try {
      started = await playTrackFromPayload(payload, { startSeconds, takeover: true });
      return started;
    } finally {
      // The engine never had this token: left behind, it would refuse this device's own next Play until stale.
      if (!started) await discardPlaybackClaim(result);
    }
  }
  // The reference is renewed with the first heartbeat: its expiry was never told here.
  acceptPlaybackClaim(result, { path: result.path, track: result.track,
    referenceExpiresAt: new Date(0).toISOString() });
  // Before this tab sounds, and without the server: for a tab of this browser that could not be asked.
  if (result.previousClientId) announcePlaybackOwnership('taken-over', result.previousClientId);
  return playTrackFromPayload(payload, { startSeconds, ownershipClaimed: true });
}

function takenOverTrack({ path, track, position }) {
  const song = normalizePlaybackOwnershipTrack(track);
  return {
    src: `/track?path=${encodeURIComponent(path)}`,
    path,
    title: song.title || 'Track',
    artist: song.artist,
    albumArtist: '',
    album: song.album,
    coverRef: '',
    durationSeconds: position ? position.durationMs / 1000 : 0,
  };
}

/**
 * Where [track] is, so another client can continue it there: `{ position }`, or nothing while the
 * player still holds another song (a start claims before its song loads) or its length is unknown.
 */
function positionField(track) {
  if (typeof getPlayerPlaybackSnapshot !== 'function') return {};
  const playback = getPlayerPlaybackSnapshot();
  if (track?.src && playback.src && playback.src !== track.src) return {};
  const durationMs = Math.round((Number(playback.duration) || 0) * 1000);
  if (durationMs < 1) return {};
  const ms = Math.min(durationMs, Math.max(0, Math.round((Number(playback.currentTime) || 0) * 1000)));
  return { position: { ms, durationMs } };
}

function isActivePlaybackOwner() {
  const claim = getPlaybackOwnershipState().activeClaim;
  return Boolean(claim?.claimToken && claim.leaseDeadline > performance.now());
}

function canEmitPlaybackSessionSideEffects() {
  // An engine that holds its own claim authorizes listen writes by it.
  const engine = playingEngine();
  return engine?.holdsOwnClaim ? engine.ownsPlayback() : isActivePlaybackOwner();
}

/** The held claim's last answer says this account's listens cannot reach Last.fm. */
function isScrobblingUnavailableAtClaim() {
  return getPlaybackOwnershipState().activeClaim?.scrobblingAvailable === false;
}

function getPlaybackClaimContext() {
  const claim = getPlaybackOwnershipState().activeClaim;
  return isActivePlaybackOwner() ? { clientId: getPlaybackOwnershipTabId(), claimToken: claim.claimToken } : {};
}

function isPlaybackLockedByAnotherTab() { return getPlaybackOwnershipState().lockStatus === 'locked'; }
/**
 * Whether this client could play what it took over. An engine with its own claim must say it takes over
 * and name its client; an installed app from before that fails closed and offers no Play here.
 */
function canTakePlaybackOverHere() {
  if (isShellPlaybackUnavailable()) return false;
  const engine = playingEngine();
  return !engine?.holdsOwnClaim || Boolean(engine.takesOver?.() && engine.claimClientId());
}
/** Another client of this account plays now and this one may take playback over. */
function isPlaybackPlayingElsewhere() {
  const ownership = getPlaybackOwnershipState();
  return ownership.lockStatus === 'locked' && ownership.blockedReason === 'playing_in_another_tab'
    && canTakePlaybackOverHere();
}
function getMirroredPlaybackTrack() { return getPlaybackOwnershipState().mirroredTrack; }

function initPlaybackOwnershipCoordinator() {
  if (window?.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.media.read')) return;
  const ownership = getPlaybackOwnershipState();
  if (ownership.initialized) return;
  ownership.initialized = true;
  getPlaybackOwnershipTabId();
  if (typeof BroadcastChannel === 'function') {
    ownership.channel = new BroadcastChannel(PLAYBACK_OWNERSHIP_CHANNEL_NAME);
    ownership.channel.addEventListener('message', receivePlaybackOwnershipMessage);
  }
  startPlaybackOwnershipHeartbeat();
  void handlePlaybackOwnershipEvent();
}
