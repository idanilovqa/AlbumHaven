function clampLoopTimes() {
  const duration = getPlayerDuration() || 0;
  const max = duration > 0 ? duration : Math.max(state.player.loopEnd, 30);
  state.player.loopStart = Math.max(0, Math.min(Number(state.player.loopStart) || 0, Math.max(0, max - 0.1)));
  state.player.loopEnd = Math.max(state.player.loopStart + 0.1, Math.min(Number(state.player.loopEnd) || max, max));
}

function isoNow() {
  return new Date().toISOString();
}

function unixNowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getPlayerDuration() {
  const editDuration = Number(state.player.loopEditDurationSeconds);
  if (state.player.loopActive && Number.isFinite(editDuration) && editDuration > 0) return editDuration;
  const playbackDuration = Number(getPlayerPlaybackSnapshot().duration);
  if (Number.isFinite(playbackDuration) && playbackDuration > 0) {
    if (state.player.current) state.player.current.durationSeconds = playbackDuration;
    return playbackDuration;
  }
  const currentDuration = Number(state.player.current?.durationSeconds);
  return Number.isFinite(currentDuration) && currentDuration > 0 ? currentDuration : 0;
}

function getTimelineSecondsFromClientX(clientX) {
  const els = getPlayerElements();
  const wrap = els.timeline?.getBoundingClientRect();
  const duration = getPlayerDuration() || Math.max(state.player.loopEnd, 0.1);
  if (!wrap || wrap.width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (clientX - wrap.left) / wrap.width));
  return ratio * duration;
}

function updateLoopInputsFromState() {
  const els = getPlayerElements();
  const duration = getPlayerDuration() || Math.max(state.player.loopEnd, 30);
  const max = Math.max(0.1, duration);
  const reconciledRange = els.loopRange?._loopRangeController?.render({
    startSeconds: state.player.loopStart,
    endSeconds: state.player.loopEnd,
  });
  if (reconciledRange) {
    state.player.loopStart = reconciledRange.startSeconds;
    state.player.loopEnd = reconciledRange.endSeconds;
  }
  if (els.timeline) els.timeline.max = String(max);
  if (els.loopStartInput && document.activeElement !== els.loopStartInput) {
    els.loopStartInput.value = formatLoopTime(state.player.loopStart, true);
  }
  if (els.loopEndInput && document.activeElement !== els.loopEndInput) {
    els.loopEndInput.value = formatLoopTime(state.player.loopEnd, true);
  }
}

function updatePlayerUi() {
  const els = getPlayerElements();
  const playback = getPlayerPlaybackSnapshot();
  const lockedByAnotherTab = typeof isPlaybackLockedByAnotherTab === 'function' && isPlaybackLockedByAnotherTab();
  const mirroredTrack = lockedByAnotherTab && typeof getMirroredPlaybackTrack === 'function'
    ? getMirroredPlaybackTrack()
    : null;
  const displayTrack = mirroredTrack || state.player.current;
  state.player.lastKnownWasPlaying = Boolean(!lockedByAnotherTab && !playback.paused && !playback.ended);
  const hasTrack = Boolean(displayTrack && (lockedByAnotherTab || playback.src || state.player.current?.src));
  const duration = getPlayerDuration();
  const dragPreview = Number(state.player.timelineDragPreviewSeconds);
  const current = state.player.timelineDragging && Number.isFinite(dragPreview)
    ? dragPreview
    : Number(playback.currentTime) || 0;
  if (els.timeline) {
    els.timeline.max = String(Math.max(duration, 0.1));
    els.timeline.value = String(Math.min(current, duration || current));
    els.timeline.disabled = !hasTrack || lockedByAnotherTab;
  }
  if (els.time) {
    els.time.textContent = state.player.loopActive
      ? `${formatLoopTime(state.player.loopStart, true)} - ${formatLoopTime(state.player.loopEnd, true)}`
      : lockedByAnotherTab
      ? 'Playing in another tab'
      : `${formatLoopTime(current)} / ${formatLoopTime(duration)}`;
  }
  els.loopActions?._loopActionController?.update({
    enabled: Boolean(getPlayerPlaybackSnapshot().src || state.player.current?.src),
    active: state.player.loopActive,
    busy: state.player.saveBusy || lockedByAnotherTab,
  });
  if (els.play) {
    els.play.textContent = lockedByAnotherTab ? 'Locked' : (playback.paused ? '\u25B6' : '\u23F8');
    els.play.setAttribute('aria-label', lockedByAnotherTab ? 'Playback locked in another tab' : (playback.paused ? 'Play' : 'Pause'));
    els.play.disabled = lockedByAnotherTab || !hasTrack;
  }
  els.timeline?.parentElement?.classList.toggle('is-looping', state.player.loopActive);
  if (els.timeline?.parentElement) {
    els.timeline.parentElement.classList.toggle('is-idle', !hasTrack || lockedByAnotherTab);
    els.timeline.parentElement.setAttribute('data-idle-label', lockedByAnotherTab ? 'Playing in another tab' : 'Nothing is playing');
  }
  if (els.loopRegion) els.loopRegion.hidden = !state.player.loopActive;
  if (els.loopStartHandle) els.loopStartHandle.hidden = !state.player.loopActive;
  if (els.loopEndHandle) els.loopEndHandle.hidden = !state.player.loopActive;
  const loopRangeSurface = els.loopRange?.querySelector('[data-loop-range-surface]');
  if (loopRangeSurface) loopRangeSurface.hidden = !state.player.loopActive;
  if (els.title) {
    const titleParts = [displayTrack?.artist, displayTrack?.title].filter(Boolean);
    els.title.textContent = titleParts.length
      ? `${titleParts.join(' - ')}${displayTrack?.album ? ' /' : ''}`
      : '';
  }
  if (els.albumLink) {
    els.albumLink.textContent = displayTrack?.album || '';
    els.albumLink.hidden = !displayTrack?.album;
  }
  updateLoopInputsFromState();
  updateWaveformAppearance();
  const compactPeaks = state.player.waveform?.compactPeaks?.data;
  if (state.player.loopActive && els.waveformCanvas && compactPeaks) {
    const progress = duration > 0 ? current / duration : 0;
    drawWaveformOnCanvas(els.waveformCanvas, compactPeaks, progress);
  }
  refreshTrackModalPlaybackState();
  refreshNonAlbumModalPlaybackState();
  persistPlayerState();
}

function setCurrentPlayerTrack(track, options = {}) {
  const els = getPlayerElements();
  const previousTrack = state.player.current;
  const previousTrackId = getTrackIdentity(previousTrack);
  const nextTrackId = getTrackIdentity(track);
  const previousSession = state.player.listenSession;
  const previousPlaybackSnapshot = options.previousPlaybackSnapshot || null;
  if (previousTrack && previousTrackId && previousTrackId !== nextTrackId && previousSession) {
    void finalizeListenSession('track-change', {
      session: previousSession,
      currentTime: Number(previousPlaybackSnapshot?.currentTime) || undefined,
      duration: Number(previousPlaybackSnapshot?.duration) || undefined,
    });
  }
  state.player.current = track;
  if (typeof probeCachedWaveformPeaks === 'function') {
    const cachedWaveformProbe = probeCachedWaveformPeaks(
      String(track?.path || ''),
      Number(state.player.streaming?.generation) || 0,
    );
    if (cachedWaveformProbe && typeof cachedWaveformProbe.catch === 'function') {
      void cachedWaveformProbe.catch(() => {});
    }
  }
  state.player.waveform.renderToken += 1;
  clearWaveformCanvas();
  loopEditSessionExpiryController.stop('global-player');
  state.player.loopActive = false;
  state.player.loopStart = 0;
  state.player.loopEnd = 30;
  state.player.loopEditDurationSeconds = 0;
  const titleParts = [track?.artist, track?.title].filter(Boolean);
  if (els.title) {
    els.title.textContent = titleParts.length
      ? `${titleParts.join(' - ')}${track?.album ? ' /' : ''}`
      : '';
  }
  if (els.albumLink) {
    els.albumLink.textContent = track?.album || '';
    els.albumLink.hidden = !track?.album;
  }
  if (els.coverButton) {
    const coverPath = track?.coverPath || '';
    const loadId = (state.player.coverLoadId || 0) + 1;
    state.player.coverLoadId = loadId;
    els.coverButton.hidden = false;
    els.coverButton.classList.toggle('is-idle-placeholder', !track);
    els.coverButton.style.backgroundImage = '';
    els.coverButton.textContent = '';
    if (!track) {
      els.coverButton.textContent = '';
    } else if (coverPath) {
      const coverSrc = `/cover?path=${encodeURIComponent(coverPath)}`;
      const probe = new Image();
      probe.onload = () => {
        if (state.player.coverLoadId !== loadId) return;
        els.coverButton.classList.remove('is-idle-placeholder');
        els.coverButton.style.backgroundImage = `url("${coverSrc}")`;
        els.coverButton.hidden = false;
      };
      probe.onerror = () => {
        if (state.player.coverLoadId !== loadId) return;
        els.coverButton.style.backgroundImage = '';
        els.coverButton.hidden = false;
        els.coverButton.classList.remove('is-idle-placeholder');
      };
      probe.src = coverSrc;
    } else {
      els.coverButton.classList.remove('is-idle-placeholder');
    }
  }
  updatePlayerUi();
  if (options.persist !== false) {
    persistPlayerState(true);
  }
}

function beginStreamingPlayerListenSession(track, startSeconds = 0) {
  if (typeof resumeListenSessionPlayback !== 'function') return;
  const sessionPromise = resumeListenSessionPlayback(track, startSeconds);
  if (!sessionPromise || typeof sessionPromise.then !== 'function') return;
  void sessionPromise.then((session) => (
    typeof maybeSendNowPlaying === 'function'
      ? maybeSendNowPlaying(track, session)
      : null
  ));
}

let playerTrackSelectionToken = 0;

async function playTrackFromPayload(track, options = {}) {
  const shouldAutoplay = options.autoplay !== false;
  if (shouldAutoplay && typeof canStartPlaybackInThisTab === 'function' && !canStartPlaybackInThisTab(track)) {
    return false;
  }
  if (!track?.path) return false;
  const resetTime = options.resetTime !== false;
  const previousPlaybackSnapshot = getPlayerPlaybackSnapshot();
  if (typeof startStreamingTrack !== 'function') {
    throw new Error('Streaming playback engine is unavailable');
  }
  const selectionToken = ++playerTrackSelectionToken;
  let startedRole;
  try {
    startedRole = await startStreamingTrack(track, {
      startSeconds: resetTime ? 0 : Number(previousPlaybackSnapshot.currentTime) || 0,
      autoplay: shouldAutoplay,
    });
  } catch (error) {
    if (selectionToken !== playerTrackSelectionToken) return false;
    throw error;
  }
  if (selectionToken !== playerTrackSelectionToken) return false;
  if (startedRole === null) {
    throw new Error('Streaming playback did not start');
  }
  const startedTrackPath = String(startedRole?.track?.path || '');
  if (startedTrackPath && startedTrackPath !== String(track.path)) {
    throw new Error('Streaming playback started an unexpected track identity');
  }
  setCurrentPlayerTrack(track, { previousPlaybackSnapshot });
  if (startedRole?.firstFrameNotified) {
    const reconciliation = handleStreamingPlaybackFirstFrame({
      generation: startedRole.generation,
      streamId: startedRole.streamId,
      trackPath: String(startedRole.track?.path || track.path),
    });
    if (typeof observeStreamingFacadeCallback === 'function') {
      observeStreamingFacadeCallback(reconciliation, 'first-frame-reconciliation-error');
    } else {
      void reconciliation.catch((error) => {
        console.warn('[AlbumHaven][Playback] First-frame reconciliation failed.', error);
      });
    }
  }
  if (shouldAutoplay) {
    beginStreamingPlayerListenSession(track, resetTime ? 0 : previousPlaybackSnapshot.currentTime);
  }
  updatePlayerUi();
  return true;
}

let handledStreamingFirstFrameIdentity = '';
let pendingStreamingFirstFrameIdentity = '';
let pendingStreamingFirstFrameSchedule = null;

async function handleStreamingPlaybackFirstFrame(event = {}) {
  const selectedTrackPath = String(state.player.current?.path || '');
  const renderedTrackPath = String(event.trackPath || '');
  if (renderedTrackPath && renderedTrackPath !== selectedTrackPath) return;
  const identity = [
    Number(event.generation) || 0,
    Number(event.streamId) || 0,
    renderedTrackPath || selectedTrackPath,
  ].join(':');
  if (identity === handledStreamingFirstFrameIdentity) return;
  if (identity === pendingStreamingFirstFrameIdentity) {
    return pendingStreamingFirstFrameSchedule;
  }
  const nextTrack = typeof peekNextQueuedTrack === 'function'
    ? peekNextQueuedTrack()
    : null;
  if (!nextTrack || typeof scheduleStreamingContinuity !== 'function') {
    handledStreamingFirstFrameIdentity = identity;
    return;
  }
  pendingStreamingFirstFrameIdentity = identity;
  const scheduling = Promise.resolve().then(() => scheduleStreamingContinuity(nextTrack));
  pendingStreamingFirstFrameSchedule = scheduling;
  try {
    await scheduling;
    handledStreamingFirstFrameIdentity = identity;
  } finally {
    if (pendingStreamingFirstFrameSchedule === scheduling) {
      pendingStreamingFirstFrameIdentity = '';
      pendingStreamingFirstFrameSchedule = null;
    }
  }
}

async function handleStreamingPlaybackPosition(event = {}) {
  const trackPath = String(state.player.current?.path || '');
  if (!trackPath || String(event.trackPath || '') !== trackPath) return;
  const playback = getPlayerPlaybackSnapshot();
  if (state.player.listenSession) {
    state.player.listenSession.duration_seconds = Math.round(
      (Number(playback.duration) || 0) * 1000,
    ) / 1000;
    if (typeof maybeScrobbleListenSession === 'function') {
      await maybeScrobbleListenSession(state.player.listenSession);
    }
  }
  updatePlayerUi();
}

let handledStreamingEndedIdentity = '';

async function handleStreamingPlaybackEnded(event = {}) {
  const track = state.player.current;
  const trackPath = String(track?.path || '');
  if (!trackPath || String(event.trackPath || '') !== trackPath) return;
  const identity = [event.generation, event.streamId, trackPath].join(':');
  if (identity === handledStreamingEndedIdentity) return;
  handledStreamingEndedIdentity = identity;
  const playback = getPlayerPlaybackSnapshot();
  const session = state.player.listenSession;
  if (typeof releasePlaybackOwnership === 'function') {
    releasePlaybackOwnership('stopped', track);
  }
  if (typeof finalizeListenSession === 'function') {
    await finalizeListenSession('ended', {
      session,
      currentTime: Number(event.currentTime) || Number(playback.currentTime) || 0,
      duration: Number(playback.duration) || 0,
      finishedFully: true,
    });
  }
  updatePlayerUi();
}

async function handleStreamingPlaybackBoundary(event = {}) {
  const boundaryIdentity = [
    Number(event.generation) || 0,
    Number(event.outgoingStreamId) || 0,
    Number(event.incomingStreamId) || 0,
  ].join(':');
  if (state.player.lastStreamingBoundaryIdentity === boundaryIdentity) return;
  const currentPath = String(state.player.current?.path || '');
  const outgoingPath = String(event.outgoingTrackPath || '');
  if (outgoingPath && currentPath !== outgoingPath) {
    throw new Error('Streaming boundary outgoing track identity mismatch');
  }
  const queuedPreview = typeof peekNextQueuedTrack === 'function'
    ? peekNextQueuedTrack()
    : null;
  const incomingPath = String(event.incomingTrackPath || '');
  if (event.continuityKind && event.continuityKind !== 'queued-next') {
    if (outgoingPath && currentPath !== outgoingPath) {
      throw new Error('Streaming loop boundary outgoing track identity mismatch');
    }
    if (incomingPath && currentPath !== incomingPath) {
      throw new Error('Streaming loop boundary incoming track identity mismatch');
    }
    state.player.lastStreamingBoundaryIdentity = boundaryIdentity;
    if (event.continuityKind === 'whole-track-repeat' && state.player.loopActive) {
      loopEditSessionExpiryController.noteUntouchedWholeRangeWrap('global-player');
    }
    updatePlayerUi();
    return;
  }
  if (incomingPath && queuedPreview?.path
      && String(queuedPreview.path) !== incomingPath) {
    throw new Error('Streaming boundary incoming track identity mismatch');
  }
  const promotedTrack = getNextQueuedTrack();
  if (!promotedTrack) {
    throw new Error('Streaming boundary promotion has no queued track');
  }
  if (incomingPath && String(promotedTrack.path || '') !== incomingPath) {
    throw new Error('Streaming boundary promoted track identity mismatch');
  }
  state.player.lastStreamingBoundaryIdentity = boundaryIdentity;
  const previousPlaybackSnapshot = event.outgoingPlaybackSnapshot
    || getPlayerPlaybackSnapshot();
  const outgoingSession = state.player.listenSession;
  if (outgoingSession) {
    if (state.player.listenSession === outgoingSession) {
      state.player.listenSession = null;
    }
    const finalization = finalizeListenSession('ended', {
      session: outgoingSession,
      currentTime: Number(previousPlaybackSnapshot.currentTime) || 0,
      duration: Number(previousPlaybackSnapshot.duration) || 0,
      finishedFully: true,
    });
    if (typeof observeStreamingFacadeCallback === 'function') {
      observeStreamingFacadeCallback(finalization, 'listen-session-boundary-finalization-error');
    } else if (finalization && typeof finalization.catch === 'function') {
      void finalization.catch((error) => {
        console.warn('[AlbumHaven][Playback] Boundary listen-session finalization failed.', error);
      });
    }
  }
  setCurrentPlayerTrack(promotedTrack, { previousPlaybackSnapshot });
  if (typeof resumeListenSessionPlayback === 'function') {
    const incomingSessionStart = Promise.resolve(resumeListenSessionPlayback(promotedTrack, 0)).then((incomingSession) => (
      typeof maybeSendNowPlaying === 'function'
        ? maybeSendNowPlaying(promotedTrack, incomingSession)
        : null
    ));
    if (typeof observeStreamingFacadeCallback === 'function') {
      observeStreamingFacadeCallback(incomingSessionStart, 'listen-session-boundary-start-error');
    } else {
      void incomingSessionStart.catch((error) => {
        console.warn('[AlbumHaven][Playback] Boundary listen-session start failed.', error);
      });
    }
  }
  updatePlayerUi();
  const subsequentTrack = typeof peekNextQueuedTrack === 'function'
    ? peekNextQueuedTrack()
    : null;
  if (subsequentTrack && typeof scheduleStreamingContinuity === 'function') {
    await scheduleStreamingContinuity(subsequentTrack);
  }
  if (typeof promoteWaveformPeaks === 'function') {
    try {
      void Promise.resolve(promoteWaveformPeaks(
        outgoingPath || currentPath,
        String(promotedTrack.path || ''),
        Number(event.generation) || 0,
      )).catch((error) => {
        console.warn('[AlbumHaven][Waveform] Optional peak promotion failed.', error);
      });
    } catch (error) {
      console.warn('[AlbumHaven][Waveform] Optional peak promotion failed.', error);
    }
  }
}

let streamingLoopScheduleToken = 0;
let pendingPlayerPlaybackHandoff = null;

function renewPlayerLoopExpiryAfterBoundaryEdit(range) {
  const nextStart = Number(range?.startSeconds);
  const nextEnd = Number(range?.endSeconds);
  const changed = Number.isFinite(nextStart) && Number.isFinite(nextEnd)
    && (nextStart !== Number(state.player.loopStart) || nextEnd !== Number(state.player.loopEnd));
  if (changed) loopEditSessionExpiryController.renewAfterBoundaryEdit('global-player');
  return changed;
}

function expirePlayerLoopCreation() {
  if (!state.player.loopActive) return false;
  setLoopActive(false);
  if (typeof pauseStreamingPlayback === 'function') {
    const pause = pauseStreamingPlayback();
    if (typeof observeStreamingFacadeCallback === 'function') {
      observeStreamingFacadeCallback(pause, 'loop-edit-expiry-pause-error');
    } else if (pause && typeof pause.catch === 'function') {
      void pause.catch(() => {});
    }
  }
  updatePlayerUi();
  return true;
}

function startPlayerLoopExpirySession() {
  loopEditSessionExpiryController.start({
    ownerId: 'global-player',
    onExpire: expirePlayerLoopCreation,
  });
}

function getGlobalPlayerLoopControlOptions() {
  const action = {
      enabled: Boolean(getPlayerPlaybackSnapshot().src || state.player.current?.src),
      active: state.player.loopActive,
      busy: state.player.saveBusy,
      disabledLabel: 'Start playing the track to edit the loop',
      onEnter: () => setLoopActive(true),
      onCreate: saveCurrentLoop,
      onCancel: () => setLoopActive(false),
  };
  const range = {
      getDuration: () => getPlayerDuration() || Math.max(state.player.loopEnd, 0.1),
      getRange: () => ({ startSeconds: state.player.loopStart, endSeconds: state.player.loopEnd }),
      onRangeInteractionStart: () => {
        startPlayerLoopExpirySession();
        loopEditSessionExpiryController.renewAfterBoundaryEdit('global-player');
      },
      onRangePreview: (range) => {
        renewPlayerLoopExpiryAfterBoundaryEdit(range);
        state.player.loopStart = range.startSeconds;
        state.player.loopEnd = range.endSeconds;
        updateLoopInputsFromState();
        const time = getPlayerElements().time;
        if (time) time.textContent = `${formatLoopTime(state.player.loopStart, true)} - ${formatLoopTime(state.player.loopEnd, true)}`;
      },
      onRangeCommit: (range) => {
        loopEditSessionExpiryController.renewAfterBoundaryEdit('global-player');
        state.player.loopStart = range.startSeconds;
        state.player.loopEnd = range.endSeconds;
        scheduleActiveStreamingLoop();
        updatePlayerUi();
      },
      onSeek: (seconds) => setPlayerPlaybackHead(seconds, { clampToLoop: false }),
      onCancel: () => setLoopActive(false),
  };
  return {
    action,
    range,
    buildActionMarkup: () => buildLoopEditActionControl({ ownerId: 'global-player' }),
    mountAction: (root) => mountLoopEditActionControl({
      root,
      enabled: action.enabled,
      active: action.active,
      busy: action.busy,
      disabledLabel: action.disabledLabel,
      onEnter: action.onEnter,
      onCreate: action.onCreate,
      onCancel: action.onCancel,
    }),
    mountRange: (root) => createLoopRangeController({ root, ...range }),
  };
}

function dispatchActiveStreamingLoop() {
  const track = state.player.current;
  if (!track || typeof scheduleStreamingContinuity !== 'function') return null;
  const startSeconds = Math.max(0, Number(state.player.loopStart) || 0);
  const endSeconds = Math.max(startSeconds, Number(state.player.loopEnd) || 0);
  const loopSeconds = Math.max(0, endSeconds - startSeconds);
  const durationSeconds = Math.max(0, Number(track.durationSeconds) || 0);
  const wholeTrack = startSeconds === 0 && durationSeconds > 0 && endSeconds >= durationSeconds;
  const kind = wholeTrack ? 'whole-track-repeat' : (loopSeconds <= 5 ? 'short-loop' : 'long-loop');
  return scheduleStreamingContinuity(track, { kind, startSeconds, endSeconds });
}

function scheduleActiveStreamingLoop() {
  const token = ++streamingLoopScheduleToken;
  Promise.resolve().then(() => {
    if (token !== streamingLoopScheduleToken || !state.player.loopActive) return;
    return dispatchActiveStreamingLoop();
  }).catch((error) => {
    if (typeof observeStreamingFacadeCallback === 'function') {
      observeStreamingFacadeCallback(Promise.reject(error), 'loop-control-error');
    }
  });
}

function setLoopActive(active) {
  const playback = getPlayerPlaybackSnapshot();
  if (active && (!state.player.current || !(playback.src || state.player.current?.src))) {
    showToast('Play a track before selecting a loop.', 'error', 2600);
    return;
  }
  const willActivate = Boolean(active);
  if (willActivate) {
    const duration = getPlayerDuration();
    if (!(duration > 0)) {
      showToast('Wait for the full track to finish loading before editing a loop.', 'error', 2600);
      return;
    }
    const currentTime = Math.max(0, Number(playback.currentTime) || 0);
    state.player.loopReturnTime = currentTime;
    state.player.loopWasPlaying = !playback.paused && !playback.ended;
    state.player.loopStart = 0;
    state.player.loopEnd = duration;
    state.player.loopEditDurationSeconds = duration;
    state.player.loopActive = true;
    clampLoopTimes();
    startPlayerLoopExpirySession();
    scheduleActiveStreamingLoop();
  } else {
    loopEditSessionExpiryController.stop('global-player');
    const startSeconds = Number(state.player.loopStart) || 0;
    const endSeconds = Number(state.player.loopEnd) || 0;
    if (state.player.loopActive) {
      const finalLoop = dispatchActiveStreamingLoop();
      if (typeof observeStreamingFacadeCallback === 'function') {
        observeStreamingFacadeCallback(finalLoop, 'loop-control-error');
      }
    }
    state.player.loopActive = false;
    state.player.loopEditDurationSeconds = 0;
    streamingLoopScheduleToken += 1;
    if (typeof setStreamingLoop === 'function') {
      setStreamingLoop(false, startSeconds, endSeconds);
    }
    const nextTrack = typeof peekNextQueuedTrack === 'function'
      ? peekNextQueuedTrack()
      : null;
    if (nextTrack && typeof scheduleStreamingContinuity === 'function') {
      const result = scheduleStreamingContinuity(nextTrack, {
        kind: 'queued-next', startSeconds: 0,
      });
      if (typeof observeStreamingFacadeCallback === 'function') {
        observeStreamingFacadeCallback(result, 'loop-disable-continuity-error');
      }
    }
  }
  updatePlayerUi();
}

function setLoopBoundary(which, value) {
  const next = Math.max(0, Number(value) || 0);
  if (which === 'start') {
    state.player.loopStart = next;
  } else {
    state.player.loopEnd = next;
  }
  clampLoopTimes();
  if (state.player.loopActive) scheduleActiveStreamingLoop();
  updatePlayerUi();
}

function setLoopPlaybackHead(value) {
  if (!state.player.loopActive) return;
  const next = Math.max(state.player.loopStart, Math.min(state.player.loopEnd, Number(value) || 0));
  if (typeof seekStreamingPlayback !== 'function') return;
  const seek = seekStreamingPlayback(next);
  if (typeof observeStreamingFacadeCallback === 'function') {
    observeStreamingFacadeCallback(seek, 'seek-control-error');
  } else if (seek && typeof seek.catch === 'function') {
    void seek.catch(() => {});
  }
  updatePlayerUi();
}

function setPlayerPlaybackHead(value, options = {}) {
  const next = Math.max(0, Number(value) || 0);
  const playback = getPlayerPlaybackSnapshot();
  const shouldResumeSegment = !playback.paused;
  closeListenSegment();
  if (state.player.loopActive && options.clampToLoop !== false) {
    setLoopPlaybackHead(next);
    if (shouldResumeSegment) void resumeListenSessionPlayback(state.player.current, next);
    return;
  }
  if (typeof seekStreamingPlayback !== 'function') return;
  const seek = seekStreamingPlayback(next);
  if (typeof observeStreamingFacadeCallback === 'function') {
    observeStreamingFacadeCallback(seek, 'seek-control-error');
  } else if (seek && typeof seek.catch === 'function') {
    void seek.catch(() => {});
  }
  if (shouldResumeSegment) void resumeListenSessionPlayback(state.player.current, next);
  updatePlayerUi();
}

function isTextEntryElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  const tagName = String(element.tagName || '').toUpperCase();
  if (tagName === 'TEXTAREA') return true;
  if (element.isContentEditable) return true;
  if (tagName !== 'INPUT') return false;
  const type = String(element.getAttribute('type') || element.type || '').toLowerCase();
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'radio', 'range', 'reset', 'submit'].includes(type);
}

function focusPlayerTimeline() {
  const els = getPlayerElements();
  const timeline = els.timeline;
  const playback = getPlayerPlaybackSnapshot();
  if (!(timeline instanceof HTMLElement) || timeline.disabled || !(playback.src || state.player.current?.src)) return;
  timeline.focus({ preventScroll: true });
}

function handlePlayerTimelineKeydown(event) {
  if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const playback = getPlayerPlaybackSnapshot();
  if (!(playback.src || state.player.current?.src)) return;
  const direction = event.key === 'ArrowLeft' ? -1 : 1;
  const stepSeconds = event.shiftKey ? 5 : 1;
  event.preventDefault();
  event.stopPropagation?.();
  setPlayerPlaybackHead((Number(playback.currentTime) || 0) + (direction * stepSeconds));
}

function handlePlayerKeyboardSeek(event) {
  if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (isTextEntryElement(target)) return;
  const insidePlayer = target?.closest?.('.global-player');
  if (!insidePlayer) return;
  handlePlayerTimelineKeydown(event);
  focusPlayerTimeline();
}

function isPlayerSurfaceVisible() {
  const player = getPlayerElements().player;
  if (!(player instanceof HTMLElement) || player.hidden) return false;
  const style = getComputedStyle(player);
  const bounds = player.getBoundingClientRect();
  const opacity = Number.parseFloat(style.opacity);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse'
    && (!Number.isFinite(opacity) || opacity > 0)
    && bounds.width > 0
    && bounds.height > 0;
}

function togglePlayerPlayback(options = {}) {
  const focusTimelineOnResume = options.focusTimelineOnResume !== false;
  const playback = getPlayerPlaybackSnapshot();
  if (!(playback.src || state.player.current?.src)) return false;
  if (typeof resumeStreamingPlayback !== 'function'
      || typeof pauseStreamingPlayback !== 'function') return false;
  if (playback.paused) {
    if (typeof canStartPlaybackInThisTab === 'function' && !canStartPlaybackInThisTab(state.player.current)) {
      return false;
    }
    const restart = playback.ended && typeof seekStreamingPlayback === 'function'
      ? seekStreamingPlayback(0)
      : null;
    Promise.resolve(restart).then(() => resumeStreamingPlayback()).then((resumed) => {
      if (resumed === false) return;
      beginStreamingPlayerListenSession(
        state.player.current,
        playback.ended ? 0 : (Number(playback.currentTime) || 0),
      );
      updatePlayerUi();
      if (focusTimelineOnResume) focusPlayerTimeline();
    }).catch(() => {});
  } else {
    pausePlayerPlaybackForHandoff(playback);
  }
  return true;
}

function pausePlayerPlaybackForHandoff(playback = getPlayerPlaybackSnapshot()) {
  if (pendingPlayerPlaybackHandoff) return pendingPlayerPlaybackHandoff;
  if (playback.paused || typeof pauseStreamingPlayback !== 'function') return Promise.resolve(false);
  const pauseEffects = Promise.resolve(pauseStreamingPlayback()).then(() => {
    closeListenSegment();
    markListenSessionPaused(Number(playback.currentTime) || 0);
    if (typeof maybeScrobbleListenSession === 'function') {
      void maybeScrobbleListenSession(state.player.listenSession);
    }
    if (typeof releasePlaybackOwnership === 'function') {
      releasePlaybackOwnership('paused', state.player.current);
    }
    updatePlayerUi();
    return true;
  });
  const trackedPause = pauseEffects.finally(() => {
    if (pendingPlayerPlaybackHandoff === trackedPause) pendingPlayerPlaybackHandoff = null;
  });
  pendingPlayerPlaybackHandoff = trackedPause;
  if (typeof observeStreamingFacadeCallback === 'function') {
    observeStreamingFacadeCallback(trackedPause, 'pause-control-error');
  } else {
    void trackedPause.catch(() => {});
  }
  return trackedPause;
}

function handlePlayerKeyboardPlayback(event) {
  if (
    !event
    || event.defaultPrevented
    || event.isComposing
    || event.repeat
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return false;
  if (event.key !== ' ' && event.key !== 'Spacebar' && event.code !== 'Space') return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (isTextEntryElement(target)) return false;
  if (
    typeof handleUtilityLoopSpacePlayback === 'function'
    && handleUtilityLoopSpacePlayback(event)
  ) {
    event.preventDefault();
    event.stopPropagation?.();
    return true;
  }
  const playback = getPlayerPlaybackSnapshot();
  if (!(playback.src || state.player.current?.src)) return false;
  if (!isPlayerSurfaceVisible()) return false;
  if (!togglePlayerPlayback({ focusTimelineOnResume: false })) return false;
  event.preventDefault();
  event.stopPropagation?.();
  return true;
}

async function saveCurrentLoop() {
  if (state.player.saveBusy) return;
  const current = state.player.current;
  if (!current || !state.player.loopActive) return;
  state.player.saveBusy = true;
  try {
    const name = String(await showLoopNameDialog() || '').trim();
    if (!name) return;
    const response = await fetch('/loops/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        source_path: current.path,
        start_seconds: state.player.loopStart,
        end_seconds: state.player.loopEnd,
        artist: current.artist || '',
        title: current.title || '',
        album: current.album || '',
        cover_path: current.coverPath || '',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to save loop');
    }
    state.utility.loops = Array.isArray(data.loops) ? data.loops : [data.loop, ...(state.utility.loops || [])].filter(Boolean);
    state.utility.loopsLoaded = true;
    state.utility.selectedLoopId = String(data.loop?.id || state.utility.selectedLoopId || '');
    state.utility.selectedLoopGroupKey = data.loop ? buildUtilityLoopGroupKey(data.loop) : state.utility.selectedLoopGroupKey;
    state.utility.selectedLoopDetailMode = 'group';
    setLoopActive(false);
    showToast('Loop saved.', 'success', 2600);
    if (state.utility.activeTab === 'loops') renderUtilityModalContent();
  } catch (error) {
    console.error('[AlbumHaven][Loops] Failed to save loop.', error);
    showToast(error.message || 'Failed to save loop.', 'error', 4200);
  } finally {
    state.player.saveBusy = false;
    updatePlayerUi();
  }
}

function handlePlayerLoopEditKeydown(event) {
  if (!event || !state.player.loopActive) return false;
  if (event.key === 'Escape') {
    setLoopActive(false);
    return true;
  }
  if (
    event.key !== 'Enter'
    || event.defaultPrevented
    || event.isComposing
    || event.repeat
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (isTextEntryElement(target) || target?.closest?.('[role="dialog"], dialog, [aria-modal="true"]')) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation?.();
  void saveCurrentLoop();
  return true;
}

function attachSharedPlayer() {
  document.querySelectorAll('.play-track-button').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const src = btn.getAttribute('data-src');
      if (!src) return;
      const trackPath = btn.getAttribute('data-track-path') || decodeURIComponent((src.split('path=')[1] || '').split('&')[0] || '');
      const isCurrentTrack = String(state.player.current?.path || '') === String(trackPath || '');
      const playback = getPlayerPlaybackSnapshot();
      const isLoadedCurrentTrack = isCurrentTrack && String(playback.src || '') === String(src);
      if (isLoadedCurrentTrack) {
        togglePlayerPlayback();
        updatePlayerUi();
        return;
      }
      const currentAlbum = !document.getElementById('track-modal')?.hidden
        ? state.modalReleases[state.modalReleaseIndex] || null
        : null;
      const playbackStart = playTrackFromPayload({
        src,
        path: trackPath,
        title: btn.getAttribute('data-track-title') || 'Track',
        artist: btn.getAttribute('data-track-artist') || '',
        albumArtist: btn.getAttribute('data-track-album-artist') || '',
        album: btn.getAttribute('data-track-album') || '',
        coverPath: btn.getAttribute('data-track-cover') || '',
        durationSeconds: Number(btn.getAttribute('data-track-duration-seconds')) || 0,
      });
      if (currentAlbum) {
        setAlbumPlaybackQueue(currentAlbum, trackPath);
      } else {
        state.player.playbackQueue = null;
      }
      if (typeof observeStreamingFacadeCallback === 'function') {
        observeStreamingFacadeCallback(playbackStart, 'track-selection-start-error');
      } else {
        void playbackStart.catch((error) => {
          console.warn('[AlbumHaven][Playback] Track selection failed.', error);
        });
      }
      focusPlayerTimeline();
    });
  });
}

function claimGlobalPlayerSpaceOwnership() {
  if (typeof clearUtilityLoopSpaceOwner === 'function') {
    clearUtilityLoopSpaceOwner();
  }
}

function attachPlayerEvents() {
  const els = getPlayerElements();

  if (typeof mountGlobalPlayerLoopControls === 'function') mountGlobalPlayerLoopControls();

  els.player?.addEventListener('pointerdown', claimGlobalPlayerSpaceOwnership);
  els.player?.addEventListener('focusin', claimGlobalPlayerSpaceOwnership);
  els.play?.addEventListener('click', () => togglePlayerPlayback());
  els.albumLink?.addEventListener('click', () => {
    const album = resolveAlbumForPlayerTrack(state.player.current);
    if (album) openTrackModal(album);
  });
  els.coverButton?.addEventListener('click', () => {
    const album = resolveAlbumForPlayerTrack(state.player.current);
    if (album) openTrackModal(album, { coverLightboxGallery: false });
  });
  els.timeline?.addEventListener('keydown', handlePlayerTimelineKeydown);
  els.timeline?.addEventListener('input', () => {
    const next = Number(els.timeline.value) || 0;
    if (state.player.timelineDragging) return;
    setPlayerPlaybackHead(next);
  });
  els.timeline?.parentElement?.addEventListener('pointerdown', (event) => {
    if (state.player.loopActive || event.target?.closest('.player-loop-handle')) return;
    if (!state.player.current) return;
    const next = getTimelineSecondsFromClientX(event.clientX);
    event.preventDefault();
    state.player.timelineDragging = true;
    state.player.timelineDragPreviewSeconds = next;
    if (els.timeline) els.timeline.value = String(next);
  });
  document.addEventListener('pointermove', (event) => {
    if (!state.player.timelineDragging) return;
    const next = getTimelineSecondsFromClientX(event.clientX);
    state.player.timelineDragPreviewSeconds = next;
    if (els.timeline) els.timeline.value = String(next);
  });
  document.addEventListener('pointerup', () => {
    if (state.player.timelineDragging) {
      const next = Number(state.player.timelineDragPreviewSeconds);
      if (Number.isFinite(next)) setPlayerPlaybackHead(next);
    }
    state.player.timelineDragging = false;
    state.player.timelineDragPreviewSeconds = null;
  });
  document.addEventListener('keydown', handlePlayerKeyboardSeek);
  document.addEventListener('keydown', handlePlayerKeyboardPlayback, { capture: true });
  els.loopStartInput?.addEventListener('change', () => {
    const value = parseLoopTime(els.loopStartInput.value);
    if (Number.isFinite(value)) setLoopBoundary('start', value);
    else updateLoopInputsFromState();
  });
  els.loopEndInput?.addEventListener('change', () => {
    const value = parseLoopTime(els.loopEndInput.value);
    if (Number.isFinite(value)) setLoopBoundary('end', value);
    else updateLoopInputsFromState();
  });
  document.addEventListener('keydown', handlePlayerLoopEditKeydown);
  window.addEventListener('resize', () => {
    updateWaveformAppearance();
  });
  if (!state.player.current) {
    setCurrentPlayerTrack(null, { persist: false });
  }
  updatePlayerUi();
  restorePlayerState();
}
