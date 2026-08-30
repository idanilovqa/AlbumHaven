const PLAYBACK_OWNERSHIP_STORAGE_KEY = 'albumhaven.playbackOwnership.v1';
const PLAYBACK_OWNERSHIP_CHANNEL_NAME = 'albumhaven.playbackOwnership.v1';
const PLAYBACK_OWNERSHIP_LEASE_MS = 15000;
const PLAYBACK_OWNERSHIP_HEARTBEAT_MS = 5000;

function getPlaybackOwnershipState() {
  if (!state?.player) {
    return {
      tabId: '',
      lockStatus: 'unlocked',
      blockedReason: '',
      mirroredTrack: null,
      activeClaim: null,
      channel: null,
      heartbeatTimer: 0,
      initialized: false,
    };
  }
  if (!state.player.ownership || typeof state.player.ownership !== 'object') {
    state.player.ownership = {
      tabId: '',
      lockStatus: 'unlocked',
      blockedReason: '',
      mirroredTrack: null,
      activeClaim: null,
      channel: null,
      heartbeatTimer: 0,
      initialized: false,
    };
  }
  return state.player.ownership;
}

function normalizePlaybackOwnershipTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const normalizedPath = String(track.path || '').trim();
  const normalizedSrc = String(track.src || '').trim();
  if (!normalizedPath && !normalizedSrc) return null;
  return {
    src: normalizedSrc,
    path: normalizedPath,
    title: String(track.title || '').trim(),
    artist: String(track.artist || '').trim(),
    album: String(track.album || '').trim(),
    coverPath: String(track.coverPath || '').trim(),
    trackNumber: String(track.trackNumber || '').trim(),
  };
}

function createPlaybackOwnershipTabId() {
  if (window?.crypto?.randomUUID) {
    return String(window.crypto.randomUUID());
  }
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function getPlaybackOwnershipTabId() {
  const ownership = getPlaybackOwnershipState();
  if (!ownership.tabId) {
    ownership.tabId = createPlaybackOwnershipTabId();
  }
  return ownership.tabId;
}

function parsePlaybackOwnershipRecord(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab_id: String(parsed.tab_id || '').trim(),
      status: String(parsed.status || '').trim().toLowerCase(),
      reason: String(parsed.reason || '').trim(),
      updated_at_ms: Number(parsed.updated_at_ms || 0) || 0,
      expires_at_ms: Number(parsed.expires_at_ms || 0) || 0,
      track: normalizePlaybackOwnershipTrack(parsed.track),
    };
  } catch (_error) {
    return null;
  }
}

function readPlaybackOwnershipRecord() {
  return parsePlaybackOwnershipRecord(getLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY));
}

function isPlaybackOwnershipRecordActive(record) {
  return Boolean(
    record
    && record.tab_id
    && record.status === 'playing'
    && Number(record.expires_at_ms || 0) > Date.now()
  );
}

function buildPlaybackOwnershipRecord(track, status = 'playing', reason = '') {
  const normalizedTrack = normalizePlaybackOwnershipTrack(track);
  const now = Date.now();
  const normalizedStatus = String(status || '').trim().toLowerCase() || 'stopped';
  return {
    tab_id: getPlaybackOwnershipTabId(),
    status: normalizedStatus,
    reason: String(reason || '').trim(),
    updated_at_ms: now,
    expires_at_ms: normalizedStatus === 'playing' ? now + PLAYBACK_OWNERSHIP_LEASE_MS : now,
    track: normalizedTrack,
  };
}

function announcePlaybackOwnership(record) {
  if (!record) return;
  setLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY, JSON.stringify(record));
  const ownership = getPlaybackOwnershipState();
  if (ownership.channel && typeof ownership.channel.postMessage === 'function') {
    ownership.channel.postMessage(record);
  }
}

function stopPlaybackOwnershipHeartbeat() {
  const ownership = getPlaybackOwnershipState();
  if (!ownership.heartbeatTimer) return;
  clearInterval(ownership.heartbeatTimer);
  ownership.heartbeatTimer = 0;
}

function refreshPlaybackOwnershipClaim(track = null) {
  const ownership = getPlaybackOwnershipState();
  const activeClaim = ownership.activeClaim;
  if (!activeClaim) return false;
  const nextTrack = normalizePlaybackOwnershipTrack(track)
    || normalizePlaybackOwnershipTrack(state?.player?.current)
    || activeClaim.track;
  const nextRecord = buildPlaybackOwnershipRecord(nextTrack, 'playing', 'active_playback');
  ownership.activeClaim = nextRecord;
  ownership.lockStatus = 'unlocked';
  ownership.blockedReason = '';
  ownership.mirroredTrack = null;
  announcePlaybackOwnership(nextRecord);
  return true;
}

function startPlaybackOwnershipHeartbeat() {
  const ownership = getPlaybackOwnershipState();
  if (ownership.heartbeatTimer || typeof setInterval !== 'function') return;
  ownership.heartbeatTimer = setInterval(() => {
    const playback = typeof getPlayerPlaybackSnapshot === 'function'
      ? getPlayerPlaybackSnapshot()
      : { paused: true, ended: false };
    if (playback.paused || playback.ended) return;
    refreshPlaybackOwnershipClaim();
  }, PLAYBACK_OWNERSHIP_HEARTBEAT_MS);
}

function clearBlockedPlaybackState() {
  const ownership = getPlaybackOwnershipState();
  ownership.lockStatus = 'unlocked';
  ownership.blockedReason = '';
  ownership.mirroredTrack = null;
}

function syncMirroredPlaybackState(record, options = {}) {
  const ownership = getPlaybackOwnershipState();
  const wasLockedByAnotherTab = ownership.lockStatus === 'locked';
  const isActive = isPlaybackOwnershipRecordActive(record);
  const sameTab = isActive && record.tab_id === getPlaybackOwnershipTabId();
  if (sameTab) {
    ownership.activeClaim = record;
    clearBlockedPlaybackState();
    startPlaybackOwnershipHeartbeat();
    return;
  }
  ownership.activeClaim = null;
  stopPlaybackOwnershipHeartbeat();
  if (isActive) {
    ownership.lockStatus = 'locked';
    ownership.blockedReason = 'playing_in_another_tab';
    ownership.mirroredTrack = normalizePlaybackOwnershipTrack(record.track);
    if (options.pauseLocalPlayback !== false && !wasLockedByAnotherTab) {
      if (typeof stopStreamingPlayback === 'function') {
        try {
          Promise.resolve(stopStreamingPlayback('ownership-takeover')).catch((error) => {
            console.warn('[AlbumHaven][Playback] Failed to stop streaming after ownership takeover.', error);
          });
        } catch (error) {
          console.warn('[AlbumHaven][Playback] Failed to stop streaming after ownership takeover.', error);
        }
      }
    }
  } else {
    clearBlockedPlaybackState();
  }
  if (typeof updatePlayerUi === 'function') {
    updatePlayerUi();
  }
}

function notifyBlockedPlaybackStart() {
  if (typeof showToast === 'function') {
    showToast('Playback is active in another tab.', 'error', 2800);
  }
}

function claimPlaybackOwnership(track, options = {}) {
  const activeRecord = readPlaybackOwnershipRecord();
  if (isPlaybackOwnershipRecordActive(activeRecord) && activeRecord.tab_id !== getPlaybackOwnershipTabId()) {
    syncMirroredPlaybackState(activeRecord);
    if (options.showBlockedToast !== false) {
      notifyBlockedPlaybackStart();
    }
    return false;
  }
  const nextRecord = buildPlaybackOwnershipRecord(
    track,
    'playing',
    String(options.reason || 'active_playback'),
  );
  const ownership = getPlaybackOwnershipState();
  ownership.activeClaim = nextRecord;
  clearBlockedPlaybackState();
  announcePlaybackOwnership(nextRecord);
  startPlaybackOwnershipHeartbeat();
  if (typeof updatePlayerUi === 'function') {
    updatePlayerUi();
  }
  return true;
}

function releasePlaybackOwnership(status = 'paused', track = null) {
  const ownership = getPlaybackOwnershipState();
  const activeRecord = ownership.activeClaim || readPlaybackOwnershipRecord();
  if (!activeRecord || activeRecord.tab_id !== getPlaybackOwnershipTabId()) {
    ownership.activeClaim = null;
    stopPlaybackOwnershipHeartbeat();
    return false;
  }
  ownership.activeClaim = null;
  stopPlaybackOwnershipHeartbeat();
  const nextRecord = buildPlaybackOwnershipRecord(
    track || state?.player?.current,
    status,
    status === 'paused' ? 'playback_paused' : 'playback_stopped',
  );
  announcePlaybackOwnership(nextRecord);
  clearBlockedPlaybackState();
  if (typeof updatePlayerUi === 'function') {
    updatePlayerUi();
  }
  return true;
}

function canRestoreActivePlayback(parsedState) {
  return claimPlaybackOwnership(parsedState?.track, {
    reason: 'restore_request',
    showBlockedToast: false,
  });
}

function canStartPlaybackInThisTab(track) {
  return claimPlaybackOwnership(track, {
    reason: 'manual_start',
    showBlockedToast: true,
  });
}

function isActivePlaybackOwner() {
  const activeRecord = readPlaybackOwnershipRecord();
  return Boolean(
    isPlaybackOwnershipRecordActive(activeRecord)
    && activeRecord.tab_id === getPlaybackOwnershipTabId()
  );
}

function canEmitPlaybackSessionSideEffects() {
  const activeRecord = readPlaybackOwnershipRecord();
  if (!isPlaybackOwnershipRecordActive(activeRecord)) return true;
  return activeRecord.tab_id === getPlaybackOwnershipTabId();
}

function isPlaybackLockedByAnotherTab() {
  const ownership = getPlaybackOwnershipState();
  return ownership.lockStatus === 'locked';
}

function getMirroredPlaybackTrack() {
  return normalizePlaybackOwnershipTrack(getPlaybackOwnershipState().mirroredTrack);
}

function handlePlaybackOwnershipEvent(record) {
  syncMirroredPlaybackState(record);
}

function initPlaybackOwnershipCoordinator() {
  const ownership = getPlaybackOwnershipState();
  if (ownership.initialized) return;
  ownership.initialized = true;
  getPlaybackOwnershipTabId();
  if (typeof window?.addEventListener === 'function') {
    window.addEventListener('storage', (event) => {
      if (event.key !== PLAYBACK_OWNERSHIP_STORAGE_KEY) return;
      handlePlaybackOwnershipEvent(parsePlaybackOwnershipRecord(event.newValue));
    });
  }
  if (typeof BroadcastChannel === 'function') {
    ownership.channel = new BroadcastChannel(PLAYBACK_OWNERSHIP_CHANNEL_NAME);
    ownership.channel.addEventListener('message', (event) => {
      handlePlaybackOwnershipEvent(parsePlaybackOwnershipRecord(JSON.stringify(event.data || null)));
    });
  }
  syncMirroredPlaybackState(readPlaybackOwnershipRecord(), { pauseLocalPlayback: false });
}
