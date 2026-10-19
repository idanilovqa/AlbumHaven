function buildPersistedPlaybackQueue(currentTrackPath) {
  const queue = state.player.playbackQueue;
  if (queue?.explicitQueue === true) return null;
  if (!queue || !Array.isArray(queue.tracks) || !queue.tracks.length) return null;
  const normalizedCurrentTrackPath = String(currentTrackPath || '');
  const queueTracks = queue.tracks
    .map((track) => {
      if (!track?.src || !track?.path) return null;
      return {
        src: String(track.src || ''),
        path: String(track.path || ''),
        title: String(track.title || ''),
        artist: String(track.artist || ''),
        ...(track.albumArtist ? { albumArtist: String(track.albumArtist) } : {}),
        album: String(track.album || ''),
        coverPath: String(track.coverPath || ''),
        ...(Number(track.durationSeconds) > 0
          ? { durationSeconds: Number(track.durationSeconds) }
          : {}),
      };
    })
    .filter(Boolean);
  if (!queueTracks.length) return null;
  const currentIndex = queueTracks.findIndex((track) => String(track.path || '') === normalizedCurrentTrackPath);
  if (currentIndex < 0) return null;
  return {
    tracks: queueTracks,
    currentIndex,
    ...(queue.albumRef ? { albumRef: String(queue.albumRef) } : {}),
    ...(queue.albumSnapshot && typeof queue.albumSnapshot === 'object' && !Array.isArray(queue.albumSnapshot)
      ? { albumSnapshot: queue.albumSnapshot }
      : {}),
  };
}

function buildPersistedPlayerState(options = {}) {
  const playback = options.playbackSnapshot || getPlayerPlaybackSnapshot();
  const current = state.player.current;
  const src = String(playback.src || current?.src || '');
  if (!current || !src) return null;
  const shouldPreservePlayingState = Boolean(options.preservePlayingState);
  const hasPlayingStateOverride = typeof options.wasPlaying === 'boolean';
  const paused = hasPlayingStateOverride
    ? Boolean(!options.wasPlaying || playback.ended)
    : (shouldPreservePlayingState
      ? Boolean(!state.player.lastKnownWasPlaying || playback.ended)
      : Boolean(playback.paused || playback.ended));
  const savedLoopStart = Number(state.player.loopStart);
  const savedLoopEnd = Number(state.player.loopEnd);
  const loopStart = Number.isFinite(savedLoopStart) ? Math.max(0, savedLoopStart) : 0;
  const loopEnd = Number.isFinite(savedLoopEnd) ? Math.max(loopStart, savedLoopEnd) : loopStart;
  const playbackDuration = Number(playback.duration);
  const currentDuration = Number(current.durationSeconds);
  const durationSeconds = playbackDuration > 0
    ? playbackDuration
    : (currentDuration > 0 ? currentDuration : 0);
  return {
    track: {
      src,
      path: String(current.path || ''),
      title: String(current.title || ''),
      artist: String(current.artist || ''),
      ...(current.albumArtist ? { albumArtist: String(current.albumArtist) } : {}),
      album: String(current.album || ''),
      coverPath: String(current.coverPath || ''),
      ...(durationSeconds > 0
        ? { durationSeconds }
        : {}),
    },
    playbackQueue: buildPersistedPlaybackQueue(current.path),
    currentTime: Math.max(0, Math.round((Number(playback.currentTime) || 0) * 100) / 100),
    paused,
    loop: {
      active: false,
      start: loopStart,
      end: loopEnd,
    },
  };
}

function restorePersistedPlaybackQueue(parsedState, currentTrackPath) {
  const tracks = Array.isArray(parsedState?.playbackQueue?.tracks)
    ? parsedState.playbackQueue.tracks
      .map((track) => {
        if (!track?.src || !track?.path) return null;
        return {
          src: String(track.src || ''),
          path: String(track.path || ''),
          title: String(track.title || ''),
          artist: String(track.artist || ''),
          ...(track.albumArtist ? { albumArtist: String(track.albumArtist) } : {}),
          album: String(track.album || ''),
          coverPath: String(track.coverPath || ''),
          ...(Number(track.durationSeconds) > 0
            ? { durationSeconds: Number(track.durationSeconds) }
            : {}),
        };
      })
      .filter(Boolean)
    : [];
  if (!tracks.length) return false;
  const normalizedCurrentTrackPath = String(currentTrackPath || '');
  const currentIndex = tracks.findIndex((track) => String(track.path || '') === normalizedCurrentTrackPath);
  if (currentIndex < 0) return false;
  state.player.playbackQueue = {
    tracks,
    currentIndex,
    ...(parsedState.playbackQueue.albumRef
      ? { albumRef: String(parsedState.playbackQueue.albumRef) }
      : {}),
    ...(parsedState.playbackQueue.albumSnapshot
      && typeof parsedState.playbackQueue.albumSnapshot === 'object'
      && !Array.isArray(parsedState.playbackQueue.albumSnapshot)
      ? { albumSnapshot: parsedState.playbackQueue.albumSnapshot }
      : {}),
  };
  return true;
}

function restoredPlaybackQueueHasValidAlbumSnapshot(currentTrackPath) {
  const queue = state.player.playbackQueue;
  const targetPath = String(currentTrackPath || '');
  const albumSnapshot = queue?.albumSnapshot;
  if (!queue || !targetPath || !albumSnapshot || typeof albumSnapshot !== 'object') return false;

  const queueAlbumRef = String(queue.albumRef || '').trim();
  const snapshotAlbumRef = typeof getAlbumIdentity === 'function'
    ? String(getAlbumIdentity(albumSnapshot) || '').trim()
    : '';
  if (!queueAlbumRef || snapshotAlbumRef !== queueAlbumRef) return false;

  const queueHasTrack = Array.isArray(queue.tracks)
    && queue.tracks.some((track) => String(track?.path || '') === targetPath);
  const snapshotTrackPaths = new Set([
    ...(Array.isArray(albumSnapshot.tracks)
      ? albumSnapshot.tracks.map((track) => String(track?.path || ''))
      : []),
    ...(Array.isArray(albumSnapshot.track_paths)
      ? albumSnapshot.track_paths.map((path) => String(path || ''))
      : []),
  ].filter(Boolean));
  return queueHasTrack && snapshotTrackPaths.has(targetPath);
}

function attachAlbumSnapshotToRestoredPlaybackQueue(album, currentTrack) {
  const queue = state.player.playbackQueue;
  const currentTrackPath = String(currentTrack?.path || '');
  const albumRef = typeof getAlbumIdentity === 'function'
    ? String(getAlbumIdentity(album) || '').trim()
    : '';
  const albumTracks = Array.isArray(album?.tracks) ? album.tracks : [];
  const albumTrackPaths = new Set(albumTracks.map((track) => String(track?.path || '')).filter(Boolean));
  const albumHasCurrentTrack = albumTrackPaths.has(currentTrackPath);
  const queueHasCurrentTrack = Array.isArray(queue?.tracks)
    && queue.tracks.some((track) => String(track?.path || '') === currentTrackPath);
  if (!queue || !albumRef || !albumHasCurrentTrack || !queueHasCurrentTrack) return false;

  queue.albumRef = albumRef;
  queue.albumSnapshot = album;
  const albumArtist = String(album.album_artist || album.artist || '').trim();
  if (albumArtist) {
    currentTrack.albumArtist = String(currentTrack.albumArtist || albumArtist);
    queue.tracks = queue.tracks.map((track) => ({
      ...track,
      ...(albumTrackPaths.has(String(track?.path || ''))
        ? { albumArtist: String(track?.albumArtist || albumArtist) }
        : {}),
    }));
  }
  return true;
}

let playerUnloadWasPlaying = null;
let playerUnloadStatePersisted = false;

function resetPlayerUnloadPersistence() {
  playerUnloadWasPlaying = null;
  playerUnloadStatePersisted = false;
  if (!getPlaybackOwnershipState().initialized) initPlaybackOwnershipCoordinator();
}

function persistPlayerState(force = false, options = {}) {
  if (playerUnloadStatePersisted && !options.allowAfterUnload) return;
  let snapshot = '';
  try {
    const payload = buildPersistedPlayerState(options);
    if (!payload) {
      if (force) removeLocalStorageItem(PLAYER_STATE_STORAGE_KEY);
      state.player.lastPersistedSnapshot = '';
      return;
    }
    snapshot = JSON.stringify(payload);
    if (!force && snapshot === state.player.lastPersistedSnapshot) return;
    setLocalStorageItem(PLAYER_STATE_STORAGE_KEY, snapshot);
    state.player.lastPersistedSnapshot = snapshot;
  } catch (_error) {
    // Ignore storage errors so playback never breaks.
  }
}

function persistPlayerStateForUnload(reason) {
  if (playerUnloadStatePersisted) return false;
  playerUnloadStatePersisted = true;
  const playbackSnapshot = getPlayerPlaybackSnapshot();
  if (playerUnloadWasPlaying === null) {
    playerUnloadWasPlaying = Boolean(state.player.lastKnownWasPlaying);
  }
  const unloadingHandle = getActivePlaybackOwnershipHandle();
  retirePlayerRestoreAttempt('unload');
  retirePlayerSelectionOwnership('unload');
  releasePlaybackOwnership('stopped', unloadingHandle);
  disposePlaybackOwnershipCoordinator();
  flushListenSessionOnUnload(reason);
  persistPlayerState(true, {
    preservePlayingState: true,
    wasPlaying: playerUnloadWasPlaying,
    playbackSnapshot,
    allowAfterUnload: true,
  });
  return true;
}

let playerRestoreEpoch = 0;
let playerRestoreAttempt = null;
function retirePlayerRestoreAttempt(reason = 'superseded') {
  const attempt = playerRestoreAttempt;
  if (!attempt) return;
  ++playerRestoreEpoch; playerRestoreAttempt = null;
  if (attempt.pageshow) window.removeEventListener('pageshow', attempt.pageshow);
  attempt.pageshow = null;
  const settle = attempt.settle; attempt.settle = null; settle?.(null);
  if (!attempt.handle || !releasePlaybackOwnership('stopped', attempt.handle)) cancelPlaybackAttempt(attempt.engineAttempt, reason);
}
function currentPlayerRestoreAttempt(attempt) {
  return Boolean(attempt && playerRestoreAttempt === attempt && attempt.epoch === playerRestoreEpoch
    && !playerUnloadStatePersisted && isPlaybackOwnershipScopeCurrent(attempt.scope)
    && (!window.AlbumHavenCapabilities || window.AlbumHavenCapabilities.allows('library.media.read') === true)
    && playerRestoreAttempt === attempt && attempt.epoch === playerRestoreEpoch
    && (!attempt.handle || isPlaybackOwnershipHandleCurrent(attempt.handle)));
}
function reconcileRestoredPlaybackOwnership(role) {
  const attempt = playerRestoreAttempt;
  if (!currentPlayerRestoreAttempt(attempt) || !attempt.handle || !attempt.engineAttempt
    || !isStreamingPlaybackAttemptCurrent(attempt.engineAttempt) || streamingEngineState().roles.current !== role
    || state.player.current?.path !== attempt.track.path || role?.track?.path !== attempt.track.path) return false;
  return commitPlaybackOwnership(attempt.handle, role, attempt.track);
}
function restorePlayerState() {
  const entrySelection = playerTrackSelectionToken;
  const entryRestoreEpoch = playerRestoreEpoch;
  if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.media.read')) return;
  if (entrySelection !== playerTrackSelectionToken || entryRestoreEpoch !== playerRestoreEpoch
    || state.player.restoredFromStorage) return;
  state.player.restoredFromStorage = true;
  let parsed;
  try { parsed = JSON.parse(getLocalStorageItem(PLAYER_STATE_STORAGE_KEY)); } catch { return; }
  const track = parsed?.track;
  const scope = capturePlaybackOwnershipScope();
  if (!track || Array.isArray(track) || typeof track.src !== 'string' || !track.src.trim()
    || typeof track.path !== 'string' || !track.path.trim() || !scope || !isPlaybackOwnershipScopeCurrent(scope) || entrySelection !== playerTrackSelectionToken || entryRestoreEpoch !== playerRestoreEpoch) return;
  const expectedRetirementEpoch = entryRestoreEpoch + (playerRestoreAttempt ? 1 : 0);
  retirePlayerRestoreAttempt();
  if (entrySelection !== playerTrackSelectionToken || playerRestoreEpoch !== expectedRetirementEpoch
    || playerRestoreAttempt || !isPlaybackOwnershipScopeCurrent(scope)
    || entrySelection !== playerTrackSelectionToken || playerRestoreEpoch !== expectedRetirementEpoch) return;
  const attempt = { epoch: ++playerRestoreEpoch, scope, track, handle: null, engineAttempt: null,
    pageshow: null, settle: null, role: null, autoplayHandled: false };
  playerRestoreAttempt = attempt;
  const savedPaused = typeof parsed.paused === 'boolean' ? parsed.paused : !Boolean(parsed.wasPlaying);
  const restore = async () => {
    if (!currentPlayerRestoreAttempt(attempt)) return;
    state.player.playbackQueue = null;
    const restoredQueue = restorePersistedPlaybackQueue(parsed, track.path);
    const restoredQueueHasAlbumSnapshot = restoredQueue
      && restoredPlaybackQueueHasValidAlbumSnapshot(track.path);
    if (restoredQueue
      && !restoredQueueHasAlbumSnapshot
      && typeof resolveAlbumForPlayerTrack === 'function') {
      const album = resolveAlbumForPlayerTrack(track);
      if (!currentPlayerRestoreAttempt(attempt)) return;
      if (album) attachAlbumSnapshotToRestoredPlaybackQueue(album, track);
    } else if (!restoredQueue
      && typeof resolveAlbumForPlayerTrack === 'function'
      && typeof setAlbumPlaybackQueue === 'function') {
      const album = resolveAlbumForPlayerTrack(track);
      if (!currentPlayerRestoreAttempt(attempt)) return;
      if (album) setAlbumPlaybackQueue(album, track.path);
    }

    const savedLoop = parsed.loop && typeof parsed.loop === 'object' ? parsed.loop : {};
    const trackDuration = Number(track.durationSeconds);
    const duration = Number.isFinite(trackDuration) ? Math.max(0, trackDuration) : 0;
    const maximumStart = duration > 0 ? Math.max(0, duration - 0.1) : Number.POSITIVE_INFINITY;
    const savedLoopStart = Number(savedLoop.start);
    const savedLoopEnd = Number(savedLoop.end);
    const loopStart = Math.min(
      maximumStart,
      Number.isFinite(savedLoopStart) ? Math.max(0, savedLoopStart) : 0,
    );
    const requestedLoopEnd = Math.max(
      loopStart + 0.1,
      Number.isFinite(savedLoopEnd) ? savedLoopEnd : 0.1,
    );
    const loopEnd = duration > 0 ? Math.min(duration, requestedLoopEnd) : requestedLoopEnd;
    const restoredLoopEnd = Math.max(loopStart, loopEnd);
    const restoredLoopActive = false;

    const savedTime = Number.isFinite(Number(parsed.currentTime)) ? Math.max(0, Number(parsed.currentTime)) : 0;
    const boundedTime = duration > 0
      ? Math.min(savedTime, Math.max(0, duration - 0.05))
      : savedTime;

    if (!currentPlayerRestoreAttempt(attempt)) return;
    const completeRestoredAutoplay = () => {
      if (!currentPlayerRestoreAttempt(attempt) || !attempt.role || state.player.current?.path !== track.path
        || !isStreamingPlaybackAttemptCurrent(attempt.engineAttempt)
        || streamingEngineState().roles.current !== attempt.role || attempt.autoplayHandled) return;
      const playback = getPlayerPlaybackSnapshot();
      if (playback.paused || playback.ended) return;
      attempt.autoplayHandled = true;
      reconcileRestoredPlaybackOwnership(attempt.role);
      if (!currentPlayerRestoreAttempt(attempt)) return;
      beginStreamingPlayerListenSession(track, boundedTime);
      if (!currentPlayerRestoreAttempt(attempt)) return;
      updatePlayerUi();
      if (currentPlayerRestoreAttempt(attempt)) persistPlayerState(true);
    };
    const startRestoredRole = () => {
      if (!currentPlayerRestoreAttempt(attempt)) return null;
      if (!savedPaused) {
        attempt.handle = canRestoreActivePlayback(parsed, { isCurrent: () => currentPlayerRestoreAttempt(attempt) });
        if (!attempt.handle || !currentPlayerRestoreAttempt(attempt)) return null;
      }
      return startStreamingTrack(track, {
        startSeconds: boundedTime, autoplay: !savedPaused,
        onStartAttempt(engineAttempt) {
          attempt.engineAttempt = engineAttempt;
          if (!currentPlayerRestoreAttempt(attempt)) { cancelPlaybackAttempt(engineAttempt, 'stale-restore'); return; }
          if (attempt.handle) bindPlaybackOwnershipAttempt(attempt.handle, engineAttempt);
        },
        ...(!savedPaused ? { allowSuspendedAutoplayFallback: true, onAutoplayStarted: completeRestoredAutoplay } : {}),
      });
    };
    const rolePromise = !savedPaused ? new Promise((resolve, reject) => {
      attempt.settle = resolve;
      attempt.pageshow = () => {
        window.removeEventListener('pageshow', attempt.pageshow); attempt.pageshow = null;
        Promise.resolve().then(() => currentPlayerRestoreAttempt(attempt) ? startRestoredRole() : null).then(resolve, reject);
      };
      window.addEventListener('pageshow', attempt.pageshow, { once: true });
    }) : startRestoredRole();
    const role = await rolePromise;
    attempt.settle = null;
    if (!currentPlayerRestoreAttempt(attempt)) return;
    if (!role || !isStreamingPlaybackAttemptCurrent(attempt.engineAttempt)
      || streamingEngineState().roles.current !== role || role.track?.path !== track.path) {
      retirePlayerRestoreAttempt('restore-failed'); return;
    }
    attempt.role = role;
    setCurrentPlayerTrack(track, { persist: false, isCurrent: () => currentPlayerRestoreAttempt(attempt) && isStreamingPlaybackAttemptCurrent(attempt.engineAttempt) });
    if (!currentPlayerRestoreAttempt(attempt) || state.player.current?.path !== track.path) return;
    state.player.loopStart = loopStart; state.player.loopEnd = restoredLoopEnd; state.player.loopActive = restoredLoopActive;
    reconcileRestoredPlaybackOwnership(role);
    if (!currentPlayerRestoreAttempt(attempt)) return;
    completeRestoredAutoplay();
    if (!currentPlayerRestoreAttempt(attempt)) return;
    updatePlayerUi();
    if (!currentPlayerRestoreAttempt(attempt)) return;
    if (typeof handleStreamingPlaybackWaveformReady === 'function') {
      try { void Promise.resolve(handleStreamingPlaybackWaveformReady({ generation: role.generation,
        currentPath: track.path, continuityPath: '' })).catch(() => {}); } catch {}
    }
    if (currentPlayerRestoreAttempt(attempt)) persistPlayerState(true);
  };
  void restore().catch(error => {
    if (!currentPlayerRestoreAttempt(attempt)) return;
    retirePlayerRestoreAttempt('restore-failed');
    state.player.lastRestoreError = { name: error?.name || 'Error', message: error?.message || String(error) };
    console.error('[AlbumHaven][Player] State restore failed.', error);
  });
}
