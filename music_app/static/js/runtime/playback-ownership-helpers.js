const PLAYBACK_OWNERSHIP_CHANNEL_NAME = 'albumhaven.playbackOwnership.v1';
const PLAYBACK_OWNERSHIP_HEARTBEAT_MS = 10000;

function getPlaybackOwnershipState() {
  return state.player.ownership ||= { tabId: '', activeClaim: null, lockStatus: 'unlocked',
    blockedReason: '', mirroredTrack: null, heartbeatTimer: 0, initialized: false };
}

function createPlaybackOwnershipTabId() {
  if (window?.crypto?.randomUUID) return String(window.crypto.randomUUID());
  return typeof newMeasuredPlaybackId === 'function' ? newMeasuredPlaybackId() : '';
}

function getPlaybackOwnershipTabId() {
  const ownership = getPlaybackOwnershipState();
  return ownership.tabId ||= createPlaybackOwnershipTabId();
}

function normalizePlaybackOwnershipTrack(track) {
  if (!track || typeof track !== 'object') return null;
  return { title: String(track.title || ''), artist: String(track.artist || ''),
    album: String(track.album || ''), artworkUrl: track.artworkUrl || null };
}

async function playbackOwnershipRequest(method, url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLAYBACK_OWNERSHIP_HEARTBEAT_MS);
  try {
    const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
      signal: controller.signal,
      ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
    if (!response.ok) throw new Error('Playback ownership is unavailable.');
    return await response.json();
  } finally { clearTimeout(timeout); }
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
  ownership.activeClaim = null;
  if (ownership.expiryTimer) clearTimeout(ownership.expiryTimer);
  ownership.lockStatus = 'locked';
  ownership.blockedReason = 'playback_unavailable';
  const offset = typeof getPlayerPlaybackSnapshot === 'function'
    ? getPlayerPlaybackSnapshot().currentTime : 0;
  if (typeof closeListenSegment === 'function') closeListenSegment(offset);
  if (!state.player.listenSession?.paused_at_unix_ms && typeof markListenSessionPaused === 'function') {
    markListenSessionPaused(offset);
  }
  if (typeof stopStreamingPlayback === 'function') {
    void Promise.resolve(stopStreamingPlayback(reason, { preserveSnapshot: true })).catch(() => {});
  }
  if (updateUi && typeof updatePlayerUi === 'function') updatePlayerUi();
}

function syncMirroredPlaybackState(snapshot) {
  const ownership = getPlaybackOwnershipState();
  if (snapshot?.is_playing_elsewhere) {
    if (ownership.blockedReason !== 'playing_in_another_tab') losePlaybackOwnership('ownership-takeover', false);
    ownership.lockStatus = 'locked';
    ownership.blockedReason = 'playing_in_another_tab';
    ownership.mirroredTrack = normalizePlaybackOwnershipTrack(snapshot.track);
  } else if (!ownership.activeClaim) {
    clearBlockedPlaybackState();
  }
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
}

async function handlePlaybackOwnershipEvent() {
  const ownership = getPlaybackOwnershipState();
  const version = ownership.requestVersion || 0;
  try {
    const snapshot = await playbackOwnershipRequest('GET',
      `/playback/state?client_id=${encodeURIComponent(getPlaybackOwnershipTabId())}`);
    if (version === (ownership.requestVersion || 0)) syncMirroredPlaybackState(snapshot);
  } catch (_error) {
    // A failed read never grants playback; acquisition still requires PUT.
  }
}

function announcePlaybackOwnership() {
  getPlaybackOwnershipState().channel?.postMessage({ type: 'changed' });
}

function startPlaybackOwnershipHeartbeat() {
  const ownership = getPlaybackOwnershipState();
  if (ownership.heartbeatTimer) return;
  ownership.heartbeatTimer = setInterval(() => {
    if (ownership.activeClaim) {
      const playback = typeof getPlayerPlaybackSnapshot === 'function' ? getPlayerPlaybackSnapshot() : null;
      if (!playback?.paused && !playback?.ended) void refreshPlaybackOwnershipClaim();
    }
    else void handlePlaybackOwnershipEvent();
  }, PLAYBACK_OWNERSHIP_HEARTBEAT_MS);
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

async function deletePlaybackClaim(claim) {
  if (!claim?.claimToken) return;
  await playbackOwnershipRequest('DELETE', '/playback/state', {
    protocol: 1, clientId: getPlaybackOwnershipTabId(), claimToken: claim.claimToken,
  });
}

function acceptPlaybackClaim(result, prepared) {
  if (result.protocol !== 1 || !result.claimToken || !(Date.parse(result.expiresAt) > Date.now())) {
    throw new Error('Playback claim is unavailable.');
  }
  const ownership = getPlaybackOwnershipState();
  const claim = { ...prepared, claimToken: result.claimToken, expiresAt: result.expiresAt };
  ownership.activeClaim = claim;
  clearBlockedPlaybackState();
  if (ownership.expiryTimer) clearTimeout(ownership.expiryTimer);
  ownership.expiryTimer = setTimeout(() => {
    if (ownership.activeClaim === claim) losePlaybackOwnership();
  }, Math.max(0, Date.parse(claim.expiresAt) - Date.now()));
  startPlaybackOwnershipHeartbeat();
  announcePlaybackOwnership();
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
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
      const prepared = await playbackOwnershipTrack(track || state.player.current, claim);
      if (version !== (ownership.requestVersion || 0)) return false;
      const result = await playbackOwnershipRequest('PUT', '/playback/state', { protocol: 1,
        clientId: getPlaybackOwnershipTabId(), clientSurface: 'private_web', claimToken: claim.claimToken,
        state: 'playing', track: prepared.track });
      if (ownership.activeClaim !== claim || version !== (ownership.requestVersion || 0)) return false;
      acceptPlaybackClaim(result, prepared);
      return true;
    } catch (_error) {
      if (ownership.activeClaim === claim && version === (ownership.requestVersion || 0)) losePlaybackOwnership();
      return false;
    }
  })().finally(() => { ownership.renewing = false; });
  ownership.pendingOperation = operation;
  return operation;
}

async function claimPlaybackOwnership(track, options = {}) {
  const ownership = getPlaybackOwnershipState();
  const version = ownership.requestVersion = (ownership.requestVersion || 0) + 1;
  const previousOperation = ownership.pendingOperation;
  const operation = (async () => {
    await previousOperation;
    if (version !== ownership.requestVersion) return false;
    const claim = ownership.activeClaim;
    try {
      const prepared = await playbackOwnershipTrack(track, claim);
      if (version !== ownership.requestVersion) return false;
      const result = await playbackOwnershipRequest('PUT', '/playback/state', { protocol: 1,
        clientId: getPlaybackOwnershipTabId(), clientSurface: 'private_web',
        claimToken: claim?.claimToken || null, state: 'playing', track: prepared.track });
      if (version !== ownership.requestVersion) {
        if (!claim) await deletePlaybackClaim(result).catch(() => {});
        return false;
      }
      acceptPlaybackClaim(result, prepared);
      return true;
    } catch (_error) {
      if (version === ownership.requestVersion) {
        losePlaybackOwnership();
        await handlePlaybackOwnershipEvent();
        if (options.showBlockedToast !== false) notifyBlockedPlaybackStart();
      }
      return false;
    }
  })();
  ownership.pendingOperation = operation;
  return operation;
}

async function releasePlaybackOwnership() {
  const ownership = getPlaybackOwnershipState();
  const version = ownership.requestVersion = (ownership.requestVersion || 0) + 1;
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
    if (ownership.expiryTimer) clearTimeout(ownership.expiryTimer);
    clearBlockedPlaybackState();
    await deletePlaybackClaim(claim).catch(() => {});
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

function canRestoreActivePlayback(parsedState) {
  return claimPlaybackOwnership(parsedState?.track, { showBlockedToast: false });
}

function canStartPlaybackInThisTab(track) { return claimPlaybackOwnership(track); }

function isActivePlaybackOwner() {
  const claim = getPlaybackOwnershipState().activeClaim;
  return Boolean(claim?.claimToken && Date.parse(claim.expiresAt) > Date.now());
}

function canEmitPlaybackSessionSideEffects() { return isActivePlaybackOwner(); }

function getPlaybackClaimContext() {
  const claim = getPlaybackOwnershipState().activeClaim;
  return isActivePlaybackOwner() ? { clientId: getPlaybackOwnershipTabId(), claimToken: claim.claimToken } : {};
}

function isPlaybackLockedByAnotherTab() { return getPlaybackOwnershipState().lockStatus === 'locked'; }
function getMirroredPlaybackTrack() { return getPlaybackOwnershipState().mirroredTrack; }

function initPlaybackOwnershipCoordinator() {
  if (window?.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.media.read')) return;
  const ownership = getPlaybackOwnershipState();
  if (ownership.initialized) return;
  ownership.initialized = true;
  getPlaybackOwnershipTabId();
  if (typeof BroadcastChannel === 'function') {
    ownership.channel = new BroadcastChannel(PLAYBACK_OWNERSHIP_CHANNEL_NAME);
    ownership.channel.addEventListener('message', handlePlaybackOwnershipEvent);
  }
  startPlaybackOwnershipHeartbeat();
  void handlePlaybackOwnershipEvent();
}
