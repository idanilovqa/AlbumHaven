function buildPersistedPlaybackQueue(currentTrackPath) {
  const queue = state.player.playbackQueue;
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
  if (typeof releasePlaybackOwnership === 'function') {
    releasePlaybackOwnership('paused', state.player.current);
  }
  flushListenSessionOnUnload(reason);
  persistPlayerState(true, {
    preservePlayingState: true,
    wasPlaying: playerUnloadWasPlaying,
    playbackSnapshot,
    allowAfterUnload: true,
  });
  return true;
}

function restorePlayerState() {
  if (state.player.restoredFromStorage) return;
  state.player.restoredFromStorage = true;
  const raw = getLocalStorageItem(PLAYER_STATE_STORAGE_KEY);
  if (!raw) return;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    return;
  }
  const track = parsed?.track;
  if (!track || !track.src) return;
  const savedPaused = typeof parsed.paused === 'boolean'
    ? parsed.paused
    : !Boolean(parsed.wasPlaying);
  const canResumePlayback = !savedPaused
    && (typeof canRestoreActivePlayback !== 'function'
      || Boolean(canRestoreActivePlayback(parsed)));
  const restore = async () => {
    state.player.playbackQueue = null;
    const restoredQueue = restorePersistedPlaybackQueue(parsed, track.path);
    const restoredQueueHasAlbumSnapshot = restoredQueue
      && restoredPlaybackQueueHasValidAlbumSnapshot(track.path);
    if (restoredQueue
      && !restoredQueueHasAlbumSnapshot
      && typeof resolveAlbumForPlayerTrack === 'function') {
      const album = resolveAlbumForPlayerTrack(track);
      if (album) attachAlbumSnapshotToRestoredPlaybackQueue(album, track);
    } else if (!restoredQueue
      && typeof resolveAlbumForPlayerTrack === 'function'
      && typeof setAlbumPlaybackQueue === 'function') {
      const album = resolveAlbumForPlayerTrack(track);
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

    const savedTime = Math.max(0, Number(parsed.currentTime) || 0);
    const boundedTime = duration > 0
      ? Math.min(savedTime, Math.max(0, duration - 0.05))
      : savedTime;
    let autoplayCompletionHandled = false;
    const completeRestoredAutoplay = () => {
      if (!canResumePlayback || autoplayCompletionHandled) return;
      autoplayCompletionHandled = true;
      if (typeof beginStreamingPlayerListenSession === 'function') {
        beginStreamingPlayerListenSession(track, boundedTime);
      }
      updatePlayerUi();
      persistPlayerState(true);
    };
    const startRestoredRole = () => startStreamingTrack(track, {
      startSeconds: boundedTime,
      autoplay: canResumePlayback,
      ...(canResumePlayback ? {
        allowSuspendedAutoplayFallback: true,
        onAutoplayStarted: completeRestoredAutoplay,
      } : {}),
    });
    const restoredRolePromise = canResumePlayback
      && typeof window !== 'undefined'
      && typeof window.addEventListener === 'function'
      ? new Promise((resolve, reject) => {
        window.addEventListener('pageshow', () => {
          Promise.resolve().then(startRestoredRole).then(resolve, reject);
        }, { once: true });
      })
      : startRestoredRole();
    setCurrentPlayerTrack(track, { persist: false });
    state.player.loopStart = loopStart;
    state.player.loopEnd = restoredLoopEnd;
    state.player.loopActive = restoredLoopActive;
    updatePlayerUi();
    const restoredRole = await restoredRolePromise;
    if (!restoredRole) return;
    if (typeof handleStreamingPlaybackWaveformReady === 'function') {
      try {
        const waveformReady = handleStreamingPlaybackWaveformReady({
          generation: Number(restoredRole.generation) || 0,
          currentPath: String(track.path || ''),
          continuityPath: '',
        });
        if (waveformReady && typeof waveformReady.catch === 'function') {
          void waveformReady.catch((error) => {
            console.warn('[AlbumHaven][Waveform] Restored-track peak load failed.', error);
          });
        }
      } catch (error) {
        console.warn('[AlbumHaven][Waveform] Restored-track peak load failed.', error);
      }
    }
    if (!autoplayCompletionHandled) persistPlayerState(true);
  };

  void restore().catch((error) => {
    state.player.lastRestoreError = {
      name: error?.name || 'Error',
      message: error?.message || String(error),
    };
    console.error('[AlbumHaven][Player] State restore failed.', error);
  });
}
