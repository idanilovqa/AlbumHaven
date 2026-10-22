const PLAYBACK_OWNERSHIP_STORAGE_KEY = 'albumhaven.playbackOwnership.v1';
const PLAYBACK_OWNERSHIP_CHANNEL_NAME = 'albumhaven.playbackOwnership.v1';
const PLAYBACK_OWNERSHIP_LEASE_MS = 15000;
const PLAYBACK_OWNERSHIP_HEARTBEAT_MS = 5000;
const playbackClaimDetails = new WeakMap();
let playbackClaimRevision = 0;
let playbackScopeEpoch = 0;
let playbackScope = null;
let playbackRejectedContext = null;
let playbackLastScopeFacts = null;
let playbackScopeSyncing = false;
let playbackDisplayChannel = null;
let playbackDisplayTimer = 0;
let playbackLeaseTimer = 0;
let playbackExpiryEpoch = 0;
let playbackDisplayEpoch = 0;
let playbackDisplayReceipt = null;

function getPlaybackOwnershipState() {
  return state.player.ownership ||= { tabId: '', lockStatus: 'unlocked', blockedReason: '',
    mirroredTrack: null, activeClaim: null, channel: null, heartbeatTimer: 0, initialized: false };
}
function createPlaybackOwnershipTabId() {
  return window.crypto?.randomUUID ? String(window.crypto.randomUUID())
    : `tab-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
function getPlaybackOwnershipTabId() {
  const owner = getPlaybackOwnershipState();
  return owner.tabId ||= createPlaybackOwnershipTabId();
}
function parsePlaybackOwnershipRecord(raw) {
  try {
    const p = JSON.parse(raw);
    if (!p || Array.isArray(p) || typeof p !== 'object'
      || typeof p.tab_id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(p.tab_id)
      || !['playing', 'paused', 'stopped'].includes(p.status)
      || !['active_playback', 'manual_start', 'restore_request', 'playback_paused', 'playback_stopped'].includes(p.reason)
      || !Number.isFinite(p.updated_at_ms) || !Number.isFinite(p.expires_at_ms)
      || p.updated_at_ms < 0 || p.updated_at_ms > Date.now()
      || p.expires_at_ms < p.updated_at_ms || p.expires_at_ms - p.updated_at_ms > PLAYBACK_OWNERSHIP_LEASE_MS
      || (p.claim_revision !== undefined && (!Number.isSafeInteger(p.claim_revision) || p.claim_revision < 0))) return null;
    // Deliberately never access legacy track or other unrecognized fields.
    return { tab_id: p.tab_id, status: p.status, reason: p.reason,
      updated_at_ms: p.updated_at_ms, expires_at_ms: p.expires_at_ms, claim_revision: p.claim_revision ?? 0 };
  } catch { return null; }
}
function readPlaybackOwnershipRecord() {
  return parsePlaybackOwnershipRecord(getLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY));
}
function isPlaybackOwnershipRecordActive(record) {
  return Boolean(record?.status === 'playing' && record.expires_at_ms > Date.now());
}
function samePlaybackClaim(record, handle) {
  return Boolean(record && handle && record.tab_id === handle.tab_id && record.claim_revision === handle.claim_revision);
}
function minimizePlaybackOwnershipStorage() {
  const raw = getLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY);
  if (!raw) return;
  const record = parsePlaybackOwnershipRecord(raw);
  const minimal = isPlaybackOwnershipRecordActive(record) ? JSON.stringify(record) : null;
  if (minimal === raw || getLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY) !== raw) return;
  if (minimal === null) removeLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY);
  else setLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY, minimal);
}
function readPlaybackScopeFacts() {
  try {
    const shell = document.getElementById('app-shell');
    const context = PrivateUITransport.context();
    const generation = PrivateUITransport.generation();
    const actor = String(shell?.dataset?.nativeAccountId || '');
    const library = String(shell?.dataset?.nativeLibraryId || '');
    if (!actor || !library || shell?.dataset?.privateUiContext !== context) return null;
    return { context, generation, actor, library };
  } catch { return null; }
}
function samePlaybackScopeFacts(a, b) {
  return Boolean(a && b && a.context === b.context && a.generation === b.generation
    && a.actor === b.actor && a.library === b.library);
}
function invalidatePlaybackPresentation() {
  state.player.coverWasOwnershipLocked = true;
  state.player.coverLoadId = (state.player.coverLoadId || 0) + 1;
  const cover = typeof getPlayerElements === 'function' ? getPlayerElements().coverButton : null;
  if (cover) { cover.style.backgroundImage = ''; cover.classList.add('is-idle-placeholder'); }
  if (typeof clearCompactPlayerArtClick === 'function') clearCompactPlayerArtClick();
}
function clearPlaybackDisplay(resetSequence = false) {
  ++playbackDisplayEpoch;
  clearTimeout(playbackDisplayTimer); playbackDisplayTimer = 0;
  if (resetSequence) playbackDisplayReceipt = null;
  getPlaybackOwnershipState().mirroredTrack = null;
  invalidatePlaybackPresentation();
}
function repaintPlaybackOwnership() {
  if (typeof updatePlayerUi === 'function') updatePlayerUi();
}
function capturePlaybackOwnershipScope() {
  if (playbackScopeSyncing) return null;
  playbackScopeSyncing = true;
  try {
    const facts = readPlaybackScopeFacts();
    if (facts && playbackLastScopeFacts && facts.context === playbackLastScopeFacts.context
      && (facts.actor !== playbackLastScopeFacts.actor || facts.library !== playbackLastScopeFacts.library)) playbackRejectedContext = facts.context;
    if (facts && playbackRejectedContext && facts.context !== playbackRejectedContext) playbackRejectedContext = null;
    if (facts?.context === playbackRejectedContext) {
      const old = playbackScope;
      if (!old) return null;
      // Retire below; never join an unchanged context with a different identity.
    } else if (samePlaybackScopeFacts(playbackScope, facts)) return playbackScope;
    const retired = getPlaybackOwnershipState().activeClaim;
    playbackScope = null; ++playbackScopeEpoch;
    const oldChannel = playbackDisplayChannel; playbackDisplayChannel = null;
    clearPlaybackDisplay(true);
    oldChannel?.close();
    if (typeof retirePlayerSelectionOwnership === 'function') retirePlayerSelectionOwnership('scope-changed');
    if (typeof retirePlayerRestoreAttempt === 'function') retirePlayerRestoreAttempt('scope-changed');
    if (retired) releasePlaybackOwnership('stopped', retired);
    // Retirement can invoke arbitrary subscribers. Re-read before attaching.
    const current = readPlaybackScopeFacts();
    if (!samePlaybackScopeFacts(facts, current) || current?.context === playbackRejectedContext) return null;
    playbackLastScopeFacts = facts;
    playbackScope = Object.freeze({ ...facts, epoch: playbackScopeEpoch });
    if (typeof BroadcastChannel === 'function') {
      const scope = playbackScope;
      try {
        const channel = new BroadcastChannel(`albumhaven.playbackDisplay.v1.${scope.context}`);
        if (playbackScope !== scope || !samePlaybackScopeFacts(scope, readPlaybackScopeFacts())) {
          channel.close(); playbackScope = null; ++playbackScopeEpoch; return null;
        }
        playbackDisplayChannel = channel;
        channel.addEventListener('message', event => receivePlaybackDisplay(event.data, scope, channel));
      } catch { playbackDisplayChannel = null; }
    }
    return playbackScope;
  } finally { playbackScopeSyncing = false; }
}
function isPlaybackOwnershipScopeCurrent(scope) {
  if (!scope || scope !== playbackScope || scope.epoch !== playbackScopeEpoch) return false;
  const facts = readPlaybackScopeFacts();
  return scope === playbackScope && scope.context !== playbackRejectedContext && samePlaybackScopeFacts(scope, facts);
}
function getActivePlaybackOwnershipHandle() { return getPlaybackOwnershipState().activeClaim; }
function isPlaybackOwnershipHandleCurrent(handle) {
  const details = handle && playbackClaimDetails.get(handle);
  if (!details || getActivePlaybackOwnershipHandle() !== handle || !isPlaybackOwnershipScopeCurrent(details.scope)) return false;
  const record = readPlaybackOwnershipRecord();
  return getActivePlaybackOwnershipHandle() === handle && isPlaybackOwnershipScopeCurrent(details.scope)
    && isPlaybackOwnershipRecordActive(record) && samePlaybackClaim(record, handle);
}
function stopPlaybackOwnershipHeartbeat() {
  const owner = getPlaybackOwnershipState();
  clearInterval(owner.heartbeatTimer); owner.heartbeatTimer = 0;
}
function cancelPlaybackAttempt(attempt, reason) {
  if (!attempt || typeof stopStreamingPlayback !== 'function') return;
  // A newer pending lease may have adopted this still-playing predecessor.
  // Use only local ownership slots here: scope/storage/presentation reads can
  // reenter. Its own failure/expiry now owns retirement of this exact attempt.
  const adopter = getPlaybackOwnershipState().activeClaim;
  if (adopter && playbackClaimDetails.get(adopter)?.attempt === attempt) return;
  // Reporting-only: an old failure must never fail the current engine.
  try { void Promise.resolve(stopStreamingPlayback(reason, { expectedAttempt: attempt })).catch(error => {
    console.warn('[AlbumHaven][Playback] Owned cancellation failed.', error);
  }); } catch (error) { console.warn('[AlbumHaven][Playback] Owned cancellation failed.', error); }
}
function releasePlaybackOwnership(status = 'paused', expectedHandle = null) {
  const owner = getPlaybackOwnershipState();
  const details = expectedHandle && playbackClaimDetails.get(expectedHandle);
  if (!details || owner.activeClaim !== expectedHandle) return false;
  const attempt = details.attempt;
  owner.activeClaim = null;
  details.attempt = null; details.role = null;
  stopPlaybackOwnershipHeartbeat();
  clearPlaybackDisplay();
  clearTimeout(details.timer);
  const raw = getLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY);
  if (samePlaybackClaim(parsePlaybackOwnershipRecord(raw), expectedHandle)
    && getLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY) === raw) removeLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY);
  // State is detached before physical cancellation can reenter.
  if (status === 'stopped') cancelPlaybackAttempt(attempt, 'ownership-retired');
  syncMirroredPlaybackState(readPlaybackOwnershipRecord());
  return true;
}
function schedulePlaybackLeaseExpiry(record) {
  const epoch = ++playbackExpiryEpoch;
  clearTimeout(playbackLeaseTimer);
  if (!isPlaybackOwnershipRecordActive(record)) return;
  playbackLeaseTimer = setTimeout(() => {
    if (epoch !== playbackExpiryEpoch) return;
    const current = readPlaybackOwnershipRecord();
    if (samePlaybackClaim(current, record) && current.expires_at_ms > Date.now()) {
      schedulePlaybackLeaseExpiry(current); return;
    }
    syncMirroredPlaybackState(current);
  }, Math.max(1, record.expires_at_ms - Date.now()));
}
function syncMirroredPlaybackState(record) {
  const owner = getPlaybackOwnershipState();
  const handle = owner.activeClaim;
  if (handle && (!isPlaybackOwnershipRecordActive(record) || !samePlaybackClaim(record, handle))) {
    releasePlaybackOwnership('stopped', handle); return;
  }
  const foreign = isPlaybackOwnershipRecordActive(record) && !samePlaybackClaim(record, handle);
  const changed = owner.lockStatus !== (foreign ? 'locked' : 'unlocked')
    || playbackDisplayReceipt && !samePlaybackClaim(record, playbackDisplayReceipt);
  owner.lockStatus = foreign ? 'locked' : 'unlocked';
  owner.blockedReason = foreign ? 'playing_in_another_tab' : '';
  if (changed || !foreign) clearPlaybackDisplay(true);
  schedulePlaybackLeaseExpiry(record);
  repaintPlaybackOwnership();
}
function notifyBlockedPlaybackStart() {
  if (typeof showToast === 'function') showToast('Playback is active in another tab.', 'error', 2800);
}
function claimPlaybackOwnership(track, options = {}) {
  const entryOwner = getActivePlaybackOwnershipHandle();
  const scope = capturePlaybackOwnershipScope();
  const callerCurrent = () => {
    const owner = getActivePlaybackOwnershipHandle(), epoch = playbackScopeEpoch;
    try {
      const valid = !options.isCurrent || options.isCurrent() === true;
      return valid && getActivePlaybackOwnershipHandle() === owner && playbackScopeEpoch === epoch;
    } catch { return false; }
  };
  if (getActivePlaybackOwnershipHandle() !== entryOwner || !callerCurrent() || typeof track?.path !== 'string' || !track.path.trim() || !scope || !isPlaybackOwnershipScopeCurrent(scope)) return false;
  const previous = getActivePlaybackOwnershipHandle();
  const stored = readPlaybackOwnershipRecord();
  if (isPlaybackOwnershipRecordActive(stored) && !samePlaybackClaim(stored, previous)) {
    syncMirroredPlaybackState(stored);
    if (options.showBlockedToast !== false) notifyBlockedPlaybackStart();
    return false;
  }
  const previousAttempt = (previous && playbackClaimDetails.get(previous)?.attempt)
    || (!getPlayerPlaybackSnapshot().paused ? captureStreamingPlaybackAttempt() : null);
  const failedReplacement = () => {
    // Cancellation itself checks exact successor adoption after all callbacks.
    cancelPlaybackAttempt(previousAttempt, 'replacement-claim-failed');
    return false;
  };
  if (previous) releasePlaybackOwnership('paused', previous);
  if (!callerCurrent() || !isPlaybackOwnershipScopeCurrent(scope) || getActivePlaybackOwnershipHandle()) return failedReplacement();
  const check = readPlaybackOwnershipRecord();
  if (isPlaybackOwnershipRecordActive(check) || !callerCurrent() || !isPlaybackOwnershipScopeCurrent(scope)) return failedReplacement();
  const handle = Object.freeze({ tab_id: getPlaybackOwnershipTabId(), claim_revision: ++playbackClaimRevision });
  const now = Date.now();
  const record = { ...handle, status: 'playing', reason: options.reason || 'manual_start',
    updated_at_ms: now, expires_at_ms: now + PLAYBACK_OWNERSHIP_LEASE_MS };
  const details = { scope, track, isCurrent: options.isCurrent, attempt: previousAttempt, role: null, sequence: 0, timer: 0 };
  playbackClaimDetails.set(handle, details);
  getPlaybackOwnershipState().activeClaim = handle;
  setLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY, JSON.stringify(record));
  if (!isPlaybackOwnershipHandleCurrent(handle)) { releasePlaybackOwnership('stopped', handle); return failedReplacement(); }
  details.timer = setTimeout(() => {
    if (getActivePlaybackOwnershipHandle() === handle && !details.role) releasePlaybackOwnership('stopped', handle);
  }, PLAYBACK_OWNERSHIP_LEASE_MS);
  try { getPlaybackOwnershipState().channel?.postMessage(record); } catch {
    releasePlaybackOwnership('stopped', handle); return failedReplacement();
  }
  syncMirroredPlaybackState(readPlaybackOwnershipRecord());
  if (!isPlaybackOwnershipHandleCurrent(handle)) { releasePlaybackOwnership('stopped', handle); return failedReplacement(); }
  return handle;
}
function bindPlaybackOwnershipAttempt(handle, attempt) {
  if (!isPlaybackOwnershipHandleCurrent(handle)) { cancelPlaybackAttempt(attempt, 'stale-selection'); return false; }
  playbackClaimDetails.get(handle).attempt = attempt;
  return true;
}
function isPlaybackOwnershipBoundaryCurrent(handle, event) {
  const details = handle && playbackClaimDetails.get(handle);
  const outgoing = details?.role;
  return Boolean(outgoing && isPlaybackOwnershipHandleCurrent(handle)
    && outgoing.generation === event.generation && outgoing.streamId === event.outgoingStreamId
    && outgoing.track?.path === event.outgoingTrackPath
    && details.track?.path === event.outgoingTrackPath
    && details.attempt && isStreamingPlaybackAttemptCurrent(details.attempt));
}
function playbackRoleHasRendered(role, track) {
  if (!role || !track?.path || typeof streamingEngineState !== 'function') return false;
  const engine = streamingEngineState();
  const snapshot = getPlayerPlaybackSnapshot();
  return engine.roles.current === role && role.generation === engine.generation
    && role.track?.path === track.path && state.player.current?.path === track.path
    && (role.firstFrameNotified === true || role.boundaryNotified === true)
    && !snapshot.paused && !snapshot.ended && !['error', 'stopped'].includes(engine.mode)
    && engine.context?.state === 'running';
}
function playbackClaimCallerCurrent(details) {
  try { return !details?.isCurrent || details.isCurrent() === true; } catch { return false; }
}
function commitPlaybackOwnership(handle, role, track = state.player.current) {
  if (!isPlaybackOwnershipHandleCurrent(handle) || !playbackRoleHasRendered(role, track)) return false;
  const details = playbackClaimDetails.get(handle);
  if (!playbackClaimCallerCurrent(details) || !isPlaybackOwnershipHandleCurrent(handle)
    || !details.attempt || !isStreamingPlaybackAttemptCurrent(details.attempt)) return false;
  const engine = streamingEngineState();
  details.isCurrent = null; // Admission callbacks cannot own later native continuity.
  details.role = role; details.track = track; details.generation = engine.generation; details.lifecycle = engine.lifecycleEpoch;
  clearTimeout(details.timer);
  if (!isPlaybackOwnershipHandleCurrent(handle)) return false;
  publishPlaybackDisplay(handle);
  startPlaybackOwnershipHeartbeat();
  return true;
}
function successfulPlaybackClaim(handle) {
  const d = handle && playbackClaimDetails.get(handle);
  if (!d?.role || !playbackClaimCallerCurrent(d) || !isPlaybackOwnershipHandleCurrent(handle) || !isStreamingPlaybackAttemptCurrent(d.attempt)) return false;
  const e = streamingEngineState();
  return e.generation === d.generation && e.lifecycleEpoch === d.lifecycle && playbackRoleHasRendered(d.role, d.track)
    && isPlaybackOwnershipHandleCurrent(handle);
}
function normalizePlaybackDisplay(display) {
  if (!display || typeof display !== 'object' || Array.isArray(display)
    || Object.keys(display).sort().join(',') !== 'album,artist,title') return null;
  const out = {};
  for (const key of ['title', 'artist', 'album']) {
    const value = display[key];
    if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return null;
    out[key] = value;
  }
  return Object.freeze(out);
}
function publishPlaybackDisplay(handle) {
  const d = playbackClaimDetails.get(handle);
  if (!d || !successfulPlaybackClaim(handle)) return false;
  const channel = playbackDisplayChannel, epoch = playbackDisplayEpoch;
  const record = readPlaybackOwnershipRecord();
  const display = normalizePlaybackDisplay({ title: String(d.track.title || ''), artist: String(d.track.artist || ''), album: String(d.track.album || '') });
  if (!channel || !display || !samePlaybackClaim(record, handle) || !successfulPlaybackClaim(handle)
    || channel !== playbackDisplayChannel || epoch !== playbackDisplayEpoch) return false;
  const now = Date.now();
  channel.postMessage({ protocol: 'albumhaven.playbackDisplay.v1', ...handle, sequence: ++d.sequence,
    issued_at_ms: now, expires_at_ms: record.expires_at_ms, display });
  return true;
}
function refreshPlaybackOwnershipClaim() {
  const handle = getActivePlaybackOwnershipHandle();
  if (!successfulPlaybackClaim(handle)) return false;
  const d = playbackClaimDetails.get(handle), epoch = playbackDisplayEpoch;
  const record = readPlaybackOwnershipRecord();
  if (!samePlaybackClaim(record, handle) || !successfulPlaybackClaim(handle)) return false;
  const now = Date.now();
  const renewed = { ...record, updated_at_ms: now, expires_at_ms: now + PLAYBACK_OWNERSHIP_LEASE_MS };
  setLocalStorageItem(PLAYBACK_OWNERSHIP_STORAGE_KEY, JSON.stringify(renewed));
  const verified = readPlaybackOwnershipRecord();
  if (!samePlaybackClaim(verified, handle) || verified.updated_at_ms !== now || verified.expires_at_ms !== renewed.expires_at_ms
    || !successfulPlaybackClaim(handle) || epoch !== playbackDisplayEpoch || playbackClaimDetails.get(handle) !== d) return false;
  schedulePlaybackLeaseExpiry(verified);
  getPlaybackOwnershipState().channel?.postMessage(verified);
  return publishPlaybackDisplay(handle);
}
function startPlaybackOwnershipHeartbeat() {
  const owner = getPlaybackOwnershipState();
  if (!owner.heartbeatTimer) owner.heartbeatTimer = setInterval(refreshPlaybackOwnershipClaim, PLAYBACK_OWNERSHIP_HEARTBEAT_MS);
}
function receivePlaybackDisplay(packet, scope, channel) {
  if (channel !== playbackDisplayChannel || !isPlaybackOwnershipScopeCurrent(scope)
    || !packet || Object.keys(packet).sort().join(',') !== 'claim_revision,display,expires_at_ms,issued_at_ms,protocol,sequence,tab_id'
    || packet.protocol !== 'albumhaven.playbackDisplay.v1' || !Number.isSafeInteger(packet.sequence) || packet.sequence <= 0) return;
  const display = normalizePlaybackDisplay(packet.display), now = Date.now();
  const lease = readPlaybackOwnershipRecord();
  if (!display || !isPlaybackOwnershipRecordActive(lease) || !samePlaybackClaim(lease, packet)
    || samePlaybackClaim(lease, getActivePlaybackOwnershipHandle())
    || !Number.isFinite(packet.issued_at_ms) || packet.issued_at_ms > now || packet.issued_at_ms < lease.updated_at_ms
    || !Number.isFinite(packet.expires_at_ms) || packet.expires_at_ms <= now || packet.expires_at_ms > lease.expires_at_ms
    || packet.expires_at_ms - packet.issued_at_ms > PLAYBACK_OWNERSHIP_LEASE_MS
    || playbackDisplayReceipt && samePlaybackClaim(playbackDisplayReceipt, packet) && packet.sequence <= playbackDisplayReceipt.sequence
    || channel !== playbackDisplayChannel || !isPlaybackOwnershipScopeCurrent(scope)) return;
  const owner = getPlaybackOwnershipState();
  owner.lockStatus = 'locked'; owner.blockedReason = 'playing_in_another_tab';
  owner.mirroredTrack = display;
  playbackDisplayReceipt = { tab_id: packet.tab_id, claim_revision: packet.claim_revision, sequence: packet.sequence, expires_at_ms: packet.expires_at_ms };
  const epoch = ++playbackDisplayEpoch;
  clearTimeout(playbackDisplayTimer);
  playbackDisplayTimer = setTimeout(() => {
    if (epoch !== playbackDisplayEpoch) return;
    clearPlaybackDisplay(); repaintPlaybackOwnership();
  }, packet.expires_at_ms - now);
  invalidatePlaybackPresentation(); repaintPlaybackOwnership();
}
function canRestoreActivePlayback(parsedState, options = {}) { return claimPlaybackOwnership(parsedState?.track, { ...options, reason: 'restore_request', showBlockedToast: false }); }
function canStartPlaybackInThisTab(track, options = {}) { return claimPlaybackOwnership(track, { ...options, reason: 'manual_start' }); }
function isActivePlaybackOwner() { return isPlaybackOwnershipHandleCurrent(getActivePlaybackOwnershipHandle()); }
function canEmitPlaybackSessionSideEffects() {
  return !isPlaybackOwnershipRecordActive(readPlaybackOwnershipRecord()) || isActivePlaybackOwner();
}
function isPlaybackLockedByAnotherTab() {
  const record = readPlaybackOwnershipRecord();
  return isPlaybackOwnershipRecordActive(record) && !samePlaybackClaim(record, getActivePlaybackOwnershipHandle());
}
function getMirroredPlaybackTrack() {
  if (!isPlaybackLockedByAnotherTab() || !isPlaybackOwnershipScopeCurrent(playbackScope)) return null;
  const lease = readPlaybackOwnershipRecord();
  if (!playbackDisplayReceipt || playbackDisplayReceipt.expires_at_ms <= Date.now()
    || !samePlaybackClaim(lease, playbackDisplayReceipt)) return null;
  return getPlaybackOwnershipState().mirroredTrack;
}
function handlePlaybackOwnershipEvent() {
  minimizePlaybackOwnershipStorage();
  capturePlaybackOwnershipScope();
  syncMirroredPlaybackState(readPlaybackOwnershipRecord());
}
function initPlaybackOwnershipCoordinator() {
  const owner = getPlaybackOwnershipState();
  if (owner.initialized) return;
  owner.initialized = true; getPlaybackOwnershipTabId();
  owner.storageListener = event => { if (event.key === PLAYBACK_OWNERSHIP_STORAGE_KEY) handlePlaybackOwnershipEvent(); };
  window.addEventListener('storage', owner.storageListener);
  if (typeof BroadcastChannel === 'function') {
    owner.channel = new BroadcastChannel(PLAYBACK_OWNERSHIP_CHANNEL_NAME);
    owner.channel.addEventListener('message', handlePlaybackOwnershipEvent);
  }
  owner.unsubscribeScope = PrivateUITransport.subscribe(() => { capturePlaybackOwnershipScope(); repaintPlaybackOwnership(); });
  const shell = document.getElementById('app-shell');
  if (shell && typeof MutationObserver === 'function') {
    owner.scopeObserver = new MutationObserver(() => { capturePlaybackOwnershipScope(); repaintPlaybackOwnership(); });
    owner.scopeObserver.observe(shell, { attributes: true, attributeFilter: ['data-native-account-id', 'data-native-library-id', 'data-private-ui-context'] });
  }
  handlePlaybackOwnershipEvent();
}

function disposePlaybackOwnershipCoordinator() {
  const owner = getPlaybackOwnershipState();
  owner.initialized = false;
  window.removeEventListener('storage', owner.storageListener);
  owner.storageListener = null;
  owner.unsubscribeScope?.(); owner.unsubscribeScope = null;
  owner.scopeObserver?.disconnect(); owner.scopeObserver = null;
  const channel = owner.channel; owner.channel = null;
  const displayChannel = playbackDisplayChannel; playbackDisplayChannel = null;
  playbackScope = null; ++playbackScopeEpoch; ++playbackExpiryEpoch;
  clearTimeout(playbackLeaseTimer); playbackLeaseTimer = 0;
  stopPlaybackOwnershipHeartbeat(); clearPlaybackDisplay(true);
  channel?.close(); displayChannel?.close();
}
